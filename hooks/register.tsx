import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import {
  ZaiClient,
  ZaiError,
  FALLBACK_MODEL,
  FALLBACK_VISION_MODEL,
  ZCODE_DEFAULT_ORIGIN,
  TOOL_WEB_SEARCH,
  TOOL_WEB_FETCH,
  mapSearchResults,
  mapReaderResult,
} from './zai.ts'
import type { SearchSource } from './zai.ts'
import { TokenStore, initLogin, pollLogin, checkAuthorizeUrl, TOKEN_TTL_MS } from './auth.ts'
import type { LoginFlow } from './auth.ts'
import { fetchBilling } from './billing.ts'
import { liveLine, logoutView, statusSummary, statusView, countdown, tickCountdown } from './status-format.ts'
import type { GatheredStatus } from './status-format.ts'
import type { Billing, LoginView, LogoutView, StatusState } from '../types'

const PLUGIN = 'cc-glm-web-search' as const
const VISION_TOOL = 'mcp__cc-glm-web-search__glm_vision' as const

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_OUTPUT_CHARS = 20_000
const DEFAULT_VISION_PROMPT = 'Describe this image in detail, and transcribe any text it contains.'
const VISION_DIRECTIVE =
  'An image is attached directly to the user turn and is visible to you in full. ' +
  'Answer from the attached image itself. Never reply that you cannot view images, ' +
  'cannot access external URLs, or need the image re-sent — the image is already here.'

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** The spinner the live rows turn. */
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// The last read of the credential and the plan, and where the browser login
// stands; the live rows draw from these.
const viewAtom = atom({ plugin: 'cc-glm-web-search', key: 'view' } as const, null as GlmView | null)
const loginAtom = atom({ plugin: 'cc-glm-web-search', key: 'login' } as const, null as LoginView | null)
const logoutAtom = atom({ plugin: 'cc-glm-web-search', key: 'logout' } as const, null as LogoutView | null)

type GlmView = { state: StatusState; billing?: Billing; error?: string }

// Module-level configuration, rewritten at every register (a reload runs it
// again); the top-level helpers below read it at call time.
type ModConfig = { origin: string; model: string | undefined; vision: boolean }
let config: ModConfig = { origin: ZCODE_DEFAULT_ORIGIN, model: undefined, vision: true }

let store: TokenStore | null = null
let client: ZaiClient | null = null
let deviceMidCache: string | undefined

// ---------- top-level helpers (the ones $ may be passed to) ----------

const getStore = async ($: EngineInterface): Promise<TokenStore> => {
  if (store) return store
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  store = new TokenStore(
    {
      readText: (path: string) => $.fs.read(path),
      writeText: (path: string, text: string) => $.fs.write(path, text),
      exists: (path: string) => $.fs.exists(path).catch(() => false),
      readEnvJwt: async () => await $.env.get('ZAI_JWT'),
      now: () => $.clock.now(),
    },
    { home },
  )
  return store
}

/**
 * Waits `ms` on a timer of the module's own (`$.clock.after`), not on
 * `$.clock.sleep`: a sleep pays out of the calling hook's ten-second
 * budget, and a gateway request may outlast it.
 */
const waitFor = ($: EngineInterface, ms: number): Promise<void> =>
  new Promise<void>(resolve => {
    $.clock.after(ms, () => resolve())
  })

const getClient = async ($: EngineInterface): Promise<ZaiClient> => {
  if (client) return client
  deviceMidCache ??= await (await getStore($))
    .deviceMid()
    .catch(() => undefined)
  client = new ZaiClient({
    origin: config.origin,
    model: config.model,
    ...(deviceMidCache ? { deviceMid: () => deviceMidCache } : {}),
    resolveToken: async () => await (await getStore($)).read(),
    deps: {
      fetchImpl: (url, init) => $.http.fetch(url, init),
      wait: ms => waitFor($, ms),
      randomId: () => crypto.randomUUID(),
    },
  })
  return client
}

/** Best-effort toast: headless hosts have none, so never let it throw. */
const showToast = ($: EngineInterface, text: string): void => {
  try {
    $.ui.toast(text)
  } catch {
    // no surface to raise a toast on
  }
}

const runSearch = async ($: EngineInterface, query: string): Promise<SearchSource[]> => {
  const gateway = await getClient($)
  const payload = await gateway.runServerTool(
    TOOL_WEB_SEARCH,
    'web_search_prime',
    `Search the web for this query and return the results: ${query}`,
    { search_query: query, count: 10 },
  )
  return mapSearchResults(payload).sources
}

const runFetch = async (
  $: EngineInterface,
  url: string,
): Promise<{ url: string; title?: string; content: string }> => {
  const gateway = await getClient($)
  const payload = await gateway.runServerTool(TOOL_WEB_FETCH, 'webReader', `Read this URL and return the page content: ${url}`, {
    url,
  })
  return mapReaderResult(payload, url)
}

const buildImageBlock = async ($: EngineInterface, image: string): Promise<Record<string, unknown>> => {
  const value = image.trim()
  if (!value) throw new ZaiError('an image URL or path is required', { code: 'ZAI_INVALID_IMAGE' })

  if (isHttpUrl(value)) {
    return { type: 'image', source: { type: 'url', url: value } }
  }

  const mediaType = MEDIA_TYPES[fileExt(value)]
  if (!mediaType) {
    throw new ZaiError(
      `"${value}" is neither an HTTP(S) URL nor a supported image file (.png, .jpg, .jpeg, .gif, .webp)`,
      { code: 'ZAI_INVALID_IMAGE' },
    )
  }

  let bytes: { base64: string }
  try {
    bytes = await $.fs.read(value, { as: 'bytes' })
  } catch (error) {
    throw new ZaiError(`the image could not be read: ${describeError(error)}`, { code: 'ZAI_INVALID_IMAGE' })
  }

  // base64 length: 4/3 of the byte count, checked without decoding
  if (bytes.base64.length * 0.75 > MAX_IMAGE_BYTES) {
    throw new ZaiError(`the image is over the ${MAX_IMAGE_BYTES / 1024 / 1024} MiB limit`, {
      code: 'ZAI_IMAGE_TOO_LARGE',
    })
  }

  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: bytes.base64 } }
}

/** Opens the authorize URL with the host's opener, by platform guess. */
const openAuthorizeUrl = async ($: EngineInterface, url: string): Promise<boolean> => {
  const os = ((await $.env.get('OS')) ?? '').toUpperCase()
  const openers: string[][] = os.includes('WIN')
    ? [['rundll32', 'url.dll,FileProtocolHandler', url]]
    : [['open', url], ['xdg-open', url]]

  for (const argv of openers) {
    try {
      await $.process.run(argv)
      return true
    } catch {
      // try the next opener
    }
  }
  return false
}

/**
 * Reads the credential state and — when one is stored — the billing
 * endpoint. A `$` call in flight does not count against this hook's
 * budget, so the network read belongs here.
 */
const gatherStatus = async ($: EngineInterface): Promise<GatheredStatus> => {
  const now = await $.clock.now()
  const tokenStore = await getStore($)
  const described = await tokenStore.source()
  const issuedAt = await tokenStore.issuedAt()
  const tokenExpiresAt = issuedAt === undefined ? undefined : issuedAt + TOKEN_TTL_MS

  const state: StatusState = {
    configured: described.configured,
    ...(described.email ? { email: described.email } : {}),
    ...(described.source ? { source: described.source } : {}),
    ...(issuedAt !== undefined ? { issuedAt } : {}),
    ...(tokenExpiresAt !== undefined ? { tokenExpiresAt } : {}),
    tokenExpired: tokenExpiresAt !== undefined ? now > tokenExpiresAt : false,
  }

  let billing: Billing | undefined
  let error: string | undefined

  if (described.configured && !state.tokenExpired) {
    try {
      const token = (await tokenStore.read()) ?? ''
      billing = await fetchBilling(
        {
          fetchImpl: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
            $.http.fetch(url, init),
        },
        { token, origin: config.origin, deviceMid: await tokenStore.deviceMid() },
      )
    } catch (caught) {
      const code = (caught as { code?: string }).code
      if (code === 'ZAI_UNAUTHENTICATED') {
        state.tokenExpired = true
        state.tokenRejected = true
      }
      error = describeError(caught)
    }
  }

  return {
    state,
    ...(billing ? { billing } : {}),
    ...(error ? { error } : {}),
    now,
  }
}

const setView = async ($: EngineInterface, gathered: GatheredStatus): Promise<void> => {
  await update($, viewAtom, () => ({
    state: gathered.state,
    ...(gathered.billing ? { billing: gathered.billing } : {}),
    ...(gathered.error ? { error: gathered.error } : {}),
  })).catch(() => {})
}

/** `/glm status`: the summary line, a blank line, then the detail view. */
const runStatus = async ($: EngineInterface): Promise<string> => {
  const gathered = await gatherStatus($)
  await setView($, gathered)
  return `${statusSummary(gathered)}\n\n${statusView(gathered)}`
}

/**
 * `/glm logout`: forget the stored credential. The row shows the revocation
 * running, then the outcome; the live quota view goes with the credential.
 */
const runLogout = async ($: EngineInterface): Promise<string> => {
  const tokenStore = await getStore($)
  const before = await tokenStore.source()

  if (!before.configured) {
    await update($, logoutAtom, () => ({ state: 'nothing' as const })).catch(() => {})
    return logoutView({ configured: false })
  }

  await update($, logoutAtom, () => ({
    state: 'revoking' as const,
    ...(before.source ? { source: before.source } : {}),
  })).catch(() => {})
  await tokenStore.clear()
  await update($, viewAtom, () => null).catch(() => {})
  await update($, loginAtom, () => null).catch(() => {})
  await update($, logoutAtom, prev => ({
    state: 'done' as const,
    ...(prev?.source ? { source: prev.source } : {}),
  })).catch(() => {})

  return logoutView({ configured: true, ...(before.source ? { source: before.source } : {}) })
}

/**
 * `/glm login`: opens the browser and returns at once. The waiting row is
 * drawn by the `glm-login` command's own output (the login atom drives it),
 * and the poll loop behind it outlives this dispatch.
 */
const startLogin = async ($: EngineInterface): Promise<string> => {
  const authDeps = {
    fetchImpl: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
      $.http.fetch(url, init),
    now: () => $.clock.now(),
  }

  const flow: LoginFlow = await initLogin(authDeps, { origin: config.origin })

  const integrity = checkAuthorizeUrl(flow.authorizeUrl)
  if (!integrity.ok) {
    return [
      'login URL is incomplete.',
      `The authorization URL is missing: ${integrity.missing.join(', ')}.`,
      'The login flow came back malformed — try again.',
    ].join('\n')
  }

  const opened = await openAuthorizeUrl($, flow.authorizeUrl)

  await update($, loginAtom, () => ({ state: 'pending' as const, expiresAt: flow.expiresAt })).catch(() => {})

  const timer = $.clock.every(flow.pollIntervalMs, () => {
    void (async () => {
      const outcome = await pollLogin(authDeps, flow, { origin: config.origin })

      if (outcome.phase === 'pending') {
        if ((await $.clock.now()) >= flow.expiresAt) {
          timer.cancel()
          await update($, loginAtom, () => ({
            state: 'failed' as const,
            error: 'the window closed — run /glm login again',
          })).catch(() => {})
          showToast($, 'Z.AI login: the window closed')
        }
        return
      }

      timer.cancel()

      if (outcome.phase === 'ready') {
        await (await getStore($)).save(outcome)
        await update($, loginAtom, () => ({
          state: 'authorized' as const,
          ...(outcome.email ? { email: outcome.email } : {}),
        })).catch(() => {})
        showToast($, `Z.AI signed in${outcome.email ? ` · ${outcome.email}` : ''}`)
        void gatherStatus($)
          .then(gathered => setView($, gathered))
          .catch(() => {})
        return
      }

      await update($, loginAtom, () => ({ state: 'failed' as const, error: outcome.message })).catch(() => {})
      showToast($, `Z.AI login failed: ${outcome.message}`)
    })().catch(async (error: unknown) => {
      timer.cancel()
      await update($, loginAtom, () => ({ state: 'failed' as const, error: describeError(error) })).catch(() => {})
      showToast($, `Z.AI login failed: ${describeError(error)}`)
    })
  })

  // The first line is drawn live by the row's hook; what the command prints
  // under it is the instruction for whichever path the browser took.
  const remaining = flow.expiresAt - (await $.clock.now())
  return [
    opened ? 'waiting for approval…' : 'approve the login in your browser',
    '',
    opened
      ? '  approve it in the browser window that just opened.'
      : `  ${flow.authorizeUrl}`,
    '',
    `  the window closes in ${countdown(remaining)}.`,
  ].join('\n')
}

/** `/glm [login|logout|status]`, the one place the three actions run. */
const runAction = async ($: EngineInterface, raw: string): Promise<string> => {
  const action = raw.trim().toLowerCase() || 'status'
  if (action === 'login') return await startLogin($)
  if (action === 'logout') return await runLogout($)
  if (action === 'status') return await runStatus($)
  return `unknown subcommand "${action}".\nUsage: /glm [login|logout|status]`
}

// ---------- pure formatters ----------

function formatSearch(sources: SearchSource[]): string {
  if (sources.length === 0) return 'No results found.'
  return sources
    .map((s, i) => {
      const parts = [`${i + 1}. ${s.title ?? s.url}`, s.url]
      if (s.snippet) parts.push(s.snippet)
      if (s.publishedAt) parts.push(`published: ${s.publishedAt}`)
      return parts.join('\n   ')
    })
    .join('\n\n')
}

function formatFetch(result: { url: string; title?: string; content: string }): string {
  const header = result.title ? `# ${result.title}\n\n` : `URL: ${result.url}\n\n`
  const body =
    result.content.length > MAX_OUTPUT_CHARS
      ? `${result.content.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated: ${result.content.length} chars total]`
      : result.content
  return header + body
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function fileExt(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = path.slice(cut + 1)
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function trimOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value.trim().replace(/\/+$/, '')
}

/**
 * What the command printed below its live first line: the summary line is
 * drawn live instead, so the rest — the detail view, blank line and all —
 * is what the drawing shows under it.
 */
function bodyOf(printed: unknown): string {
  const lines = String(printed ?? '').split('\n')
  // drop the live first line; keep everything after it, blank lines included
  return lines.slice(1).join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
}

// ---------- registration ----------

export const register: Register = (on, options) => {
  config = {
    origin: trimOrigin(options.origin) ?? ZCODE_DEFAULT_ORIGIN,
    model: typeof options.model === 'string' && options.model.trim() ? options.model.trim() : undefined,
    vision: options.vision !== false,
  }
  store = null
  client = null
  deviceMidCache = undefined

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'glm_web_search',
      description:
        'Z.AI (GLM) web search, run through the ZCode gateway on the person’s Z.AI subscription. ' +
        'Search the web when current information is needed; results come from the gateway itself.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query to use' },
        },
        required: ['query'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'glm_web_fetch',
      description:
        'Z.AI (GLM) web page reader, run through the ZCode gateway on the person’s Z.AI subscription. ' +
        'Reads one URL and returns the page’s main content.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch content from' },
        },
        required: ['url'],
      },
      isDeferred: false,
    })
    if (config.vision) {
      await $.tool.register({
        name: 'glm_vision',
        description:
          'Analyze an image with Z.AI vision: describe it, transcribe its text, or answer a question about it. ' +
          'Accepts a public image URL or a local image file path (.png, .jpg, .jpeg, .gif, .webp). ' +
          'NOTE: the ZCode plan gateway this mod signs in to does not accept image input (it answers code 1210), ' +
          'so this call fails on that gateway; image understanding needs a Z.AI open-platform API key instead.',
        inputSchema: {
          type: 'object',
          properties: {
            image: {
              type: 'string',
              description: 'Public image URL, or a path to a local image file (.png, .jpg, .jpeg, .gif, .webp).',
            },
            prompt: {
              type: 'string',
              description: `What to ask about the image. Defaults to "${DEFAULT_VISION_PROMPT}".`,
            },
          },
          required: ['image'],
        },
        isDeferred: false,
      })
    }
    await $.command.register({
      name: 'glm',
      description: 'Z.AI login, logout, and quota status',
      argumentHint: '[login|logout|status]',
    })
    // Standalone aliases: the command menu matches by name, so typing
    // `/glm-log` offers both login and logout.
    await $.command.register({
      name: 'glm-login',
      description: 'Sign in to Z.AI with your email account',
    })
    await $.command.register({
      name: 'glm-logout',
      description: 'Forget the stored Z.AI credential',
    })
    await $.command.register({
      name: 'glm-status',
      description: 'Show the Z.AI token, plan, quota and refill cycle',
    })

    // The live rows move: one ticker for the whole module repaints the
    // command-output rows once a second (the login spinner and countdown,
    // a revocation in flight, and the quota's reset timer). It runs until
    // the module unloads; the engine folds redraws past its own cap.
    $.clock.every(1000, () => {
      void (async () => {
        const login = await read($, loginAtom)
        if (login?.state === 'pending') {
          $.ui.invalidate('ui.render')
          return
        }
        const logout = await read($, logoutAtom)
        if (logout?.state === 'revoking') {
          $.ui.invalidate('ui.render')
          return
        }
        const view = await read($, viewAtom)
        if (view) $.ui.invalidate('ui.render')
      })().catch(() => {})
    })

    // The first read has the live row right from turn one.
    void gatherStatus($)
      .then(gathered => setView($, gathered))
      .catch(() => {})

    // The quota itself is re-read once a minute, so the figures follow what
    // the account spends while the live rows are up.
    $.clock.every(60_000, () => {
      void gatherStatus($)
        .then(gathered => setView($, gathered))
        .catch(() => {})
    })

    return next(e)
  })

  on('command.run', { command: 'glm' }, async ($, e) => {
    try {
      return { text: await runAction($, e.args) }
    } catch (error) {
      return { text: `/glm failed: ${describeError(error)}` }
    }
  })
  on('command.run', { command: 'glm-login' }, async $ => {
    try {
      return { text: await runAction($, 'login') }
    } catch (error) {
      return { text: `/glm-login failed: ${describeError(error)}` }
    }
  })
  on('command.run', { command: 'glm-logout' }, async $ => {
    try {
      return { text: await runAction($, 'logout') }
    } catch (error) {
      return { text: `/glm-logout failed: ${describeError(error)}` }
    }
  })
  on('command.run', { command: 'glm-status' }, async $ => {
    try {
      return { text: await runAction($, 'status') }
    } catch (error) {
      return { text: `/glm-status failed: ${describeError(error)}` }
    }
  })

  // The command's own output row, redrawn every second: a login in flight
  // shows the spinner and the window's countdown; afterwards the row keeps
  // the plan's quota ticking. The repaint comes from the module's single
  // one-second ticker (started with the session), never from a timer
  // registered here — a render hook that armed its own would arm another
  // on every redraw it caused.
  //
  // `/glm-login`'s own row. Three states, each drawn whole: waiting (spinner
  // and the window's countdown), signed in (one clean confirmation), failed
  // (the reason). The command's printed instructions only belong to the
  // waiting state — once the browser approved they are stale, so they go.
  on('ui.render', { component: 'CommandOutput', props: { command: 'glm-login' } }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const login = await read($, loginAtom)
    const view = await read($, viewAtom)
    const now = await $.clock.now()
    const frame = Math.floor(now / 1000)
    const spin = SPINNER[frame % SPINNER.length] ?? SPINNER[0]

    if (login?.state === 'pending') {
      const left = login.expiresAt !== undefined ? tickCountdown(login.expiresAt - now) : 'unknown'
      return (
        <Box flexDirection="column">
          <Text color="suggestion">{`${spin} waiting for browser approval · ${left} left`}</Text>
          <Text> </Text>
          <Text dimColor>{bodyOf(e.props.text)}</Text>
        </Box>
      )
    }

    if (login?.state === 'failed') {
      return (
        <Box>
          <Text color="error">{`✗ login failed${login.error ? `: ${login.error}` : ''}`}</Text>
        </Box>
      )
    }

    // authorized (or nothing pending): one clean line, the email when known,
    // then the live quota underneath.
    const who = login?.email ?? view?.state.email
    const quota = view ? liveLine({ ...view, now }) : undefined

    return (
      <Box flexDirection="column">
        <Text color="success">{`✓ signed in${who ? ` · ${who}` : ''}`}</Text>
        {quota !== undefined && <Text dimColor>{quota}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'glm-logout' } }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const logout = await read($, logoutAtom)
    const now = await $.clock.now()
    const spin = SPINNER[Math.floor(now / 1000) % SPINNER.length] ?? SPINNER[0]

    if (logout?.state === 'revoking') {
      return (
        <Box>
          <Text color="warning">{`${spin} revoking the Z.AI credential…`}</Text>
        </Box>
      )
    }

    const printed = String(e.props.text ?? '')
    if (logout?.state === 'nothing') {
      return (
        <Box>
          <Text dimColor>{printed.split('\n')[0] ?? 'No stored Z.AI credential to remove.'}</Text>
        </Box>
      )
    }

    // done: the confirmation line, then what stops working
    return (
      <Box flexDirection="column">
        <Text color="success">{`✓ signed out · ${logout?.source ?? 'credential'} removed`}</Text>
        <Text dimColor>{bodyOf(printed)}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'glm-status' } }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const now = await $.clock.now()

    // The first line ticks; the detail view the command printed stays.
    const printed = String(e.props.text ?? '')
    const firstPrinted = printed.split('\n')[0] ?? ''
    const head = view ? liveLine({ ...view, now }) : firstPrinted
    const body = bodyOf(printed)

    return (
      <Box flexDirection="column">
        <Text>{head}</Text>
        {body.length > 0 && <Text>{body}</Text>}
      </Box>
    )
  })

  on('tool.call', { tool: 'mcp__cc-glm-web-search__glm_web_search' }, async ($, e) => {
    const query = String(e.query ?? '').trim()
    if (!query) return { deny: 'the search query must not be empty' }

    try {
      const sources = await runSearch($, query)
      return { result: formatSearch(sources) }
    } catch (error) {
      return { isError: true, result: `${PLUGIN}: ${describeError(error)}` }
    }
  }).catch(($, e, next) => (next.called ? next(e) : { isError: true, result: `${PLUGIN}: its search hook failed.` }))

  on('tool.call', { tool: 'mcp__cc-glm-web-search__glm_web_fetch' }, async ($, e) => {
    const url = String(e.url ?? '').trim()
    if (!isHttpUrl(url)) return { deny: `"${url}" is not an absolute HTTP(S) URL` }

    try {
      const page = await runFetch($, url)
      return { result: formatFetch(page) }
    } catch (error) {
      return { isError: true, result: `${PLUGIN}: ${describeError(error)}` }
    }
  }).catch(($, e, next) => (next.called ? next(e) : { isError: true, result: `${PLUGIN}: its fetch hook failed.` }))

  on('tool.call', { tool: VISION_TOOL }, async ($, e) => {
    const image = String(e.image ?? '')
    const prompt = String(e.prompt ?? '') || DEFAULT_VISION_PROMPT

    try {
      const imageBlock = await buildImageBlock($, image)
      const gateway = await getClient($)
      // Thinking is off and the cap is small: the host's own fetch gives a
      // request thirty seconds, and a reasoning pass over an image blows
      // through that before the answer starts.
      const body = {
        model: FALLBACK_VISION_MODEL,
        max_tokens: 1024,
        stream: false,
        system: gateway.identitySystem({ type: 'text', text: VISION_DIRECTIVE }),
        messages: [
          {
            role: 'user',
            content: [imageBlock, { type: 'text', text: prompt }],
          },
        ],
        thinking: { type: 'disabled' },
      }
      const payload = await gateway.request(body, 'vision')
      const blocks = Array.isArray((payload as { content?: unknown })?.content)
        ? ((payload as { content: unknown[] }).content as { type?: string; text?: unknown }[])
        : []
      const answer = blocks
        .filter(block => block?.type === 'text')
        .map(block => String(block.text ?? ''))
        .join('')
        .trim()

      if (!answer) {
        throw new ZaiError('the vision request returned no description', { code: 'ZAI_EMPTY_RESULT' })
      }
      return { result: answer }
    } catch (error) {
      // 1210 is the ZCode plan gateway declining the image itself, whatever
      // the picture: measured with a 69-byte 1x1 PNG, a 13 KB logo over a
      // URL and the same over base64, all three refused, while the search
      // and reader server tools pass on the same credential. So the honest
      // answer names the gateway, not the caller's image.
      const raw = describeError(error)
      if (/\[1210\]|图片输入格式/.test(raw)) {
        return {
          isError: true,
          result:
            `${PLUGIN}: this Z.AI plan gateway does not accept image input (its code 1210). ` +
            'Search and reading work on the same credential; image understanding needs a Z.AI open-platform ' +
            'API key against api.z.ai, which this mod does not use. Tell the person rather than retrying.',
        }
      }
      if (/timed out|aborted/.test(raw)) {
        return {
          isError: true,
          result: `${PLUGIN}: the gateway did not answer within the 30 s a host request is allowed.`,
        }
      }
      return { isError: true, result: `${PLUGIN}: vision failed — ${raw}` }
    }
  }).catch(($, e, next) => (next.called ? next(e) : { isError: true, result: `${PLUGIN}: its vision hook failed.` }))
}

export { FALLBACK_MODEL }
