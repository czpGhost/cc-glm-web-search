import { expect, mock, test } from 'claude-code/testing'

import { parseServerToolResult, mapSearchResults, mapReaderResult } from '../hooks/zai.ts'
import { checkAuthorizeUrl, TokenStore } from '../hooks/auth.ts'
import { statusSummary, statusView, logoutView } from '../hooks/status-format.ts'

// ---------- protocol decoding ----------

test('parseServerToolResult decodes a plain JSON array', () => {
  const payload = parseServerToolResult(JSON.stringify([{ link: 'https://a.example', title: 'A' }]))
  expect(payload).toEqual([{ link: 'https://a.example', title: 'A' }])
})

test('parseServerToolResult decodes the ][ seam the gateway leaves', () => {
  const inner = JSON.stringify([{ url: 'https://b.example' }])
  const text = `[{"done":true}]${inner}`
  expect(parseServerToolResult(text)).toEqual([{ url: 'https://b.example' }])
})

test('parseServerToolResult unwraps a { text: ... } wrapper', () => {
  const text = JSON.stringify({ text: JSON.stringify([{ link: 'https://c.example' }]) })
  expect(parseServerToolResult(text)).toEqual([{ link: 'https://c.example' }])
})

test('parseServerToolResult answers null on garbage', () => {
  expect(parseServerToolResult('not json at all')).toBeNull()
})

test('mapSearchResults keeps good rows and counts dropped ones', () => {
  const { sources, dropped } = mapSearchResults([
    { link: 'https://a.example', title: 'A', content: 'snippet a' },
    { title: 'no url here' },
    null,
    { url: 'https://b.example', publish_date: '2026-01-01' },
  ])
  expect(dropped).toBe(2)
  expect(sources).toEqual([
    { url: 'https://a.example/', title: 'A', snippet: 'snippet a' },
    { url: 'https://b.example/', publishedAt: '2026-01-01' },
  ])
})

test('mapSearchResults refuses a non-http link', () => {
  const { sources } = mapSearchResults([{ link: 'javascript:alert(1)' }])
  expect(sources).toEqual([])
})

test('mapReaderResult reads the page and keeps the requested url', () => {
  const result = mapReaderResult({ title: 'T', content: 'body text' }, 'https://x.example/page')
  expect(result).toEqual({ url: 'https://x.example/page', title: 'T', content: 'body text' })
})

test('mapReaderResult accepts the url the page reported', () => {
  const result = mapReaderResult([{ url: 'https://real.example/', content: 'c' }], 'https://x.example/')
  expect(result.url).toBe('https://real.example/')
})

// ---------- authorize-url integrity ----------

test('checkAuthorizeUrl accepts a whole url', () => {
  const url =
    'https://chat.z.ai/auth/authorize?client_id=client_X&redirect_uri=https%3A%2F%2Fzcode.z.ai%2Foauth%2Fcallback&response_type=code&state=abc'
  expect(checkAuthorizeUrl(url)).toEqual({ ok: true, missing: [] })
})

test('checkAuthorizeUrl names what a truncated url is missing', () => {
  const url = 'https://chat.z.ai/auth/authorize?client_id=client_X'
  const result = checkAuthorizeUrl(url)
  expect(result.ok).toBe(false)
  expect(result.missing).toEqual(['redirect_uri', 'response_type', 'state'])
})

// ---------- the token store ----------

const files = () => {
  const map = new Map<string, string>()
  return {
    readText: async (path: string) => {
      const text = map.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    writeText: async (path: string, text: string) => {
      map.set(path, text)
    },
    exists: async (path: string) => map.has(path),
    dump: () => map,
  }
}

test('TokenStore saves, reads back and clears a credential', async () => {
  const io = files()
  let time = 1_000_000
  const store = new TokenStore(
    {
      ...io,
      readEnvJwt: async () => undefined,
      now: async () => time,
    },
    { home: 'C:/u' },
  )

  expect(await store.read()).toBeUndefined()

  await store.save({ jwt: 'jwt-one', email: 'a@b.c' })
  expect(await store.read()).toBe('jwt-one')
  expect(await store.source()).toEqual({ configured: true, source: 'token file', email: 'a@b.c' })
  expect(await store.isExpired()).toBe(false)

  time += 60 * 60 * 1000 + 1
  expect(await store.isExpired()).toBe(true)

  await store.clear()
  expect(await store.read()).toBeUndefined()
  expect(await store.source()).toEqual({ configured: false })
})

test('TokenStore keeps the device id across a logout', async () => {
  const io = files()
  const store = new TokenStore(
    {
      ...io,
      readEnvJwt: async () => undefined,
      now: async () => 0,
    },
    { home: 'C:/u' },
  )

  const mid = await store.deviceMid()
  expect(mid).toMatch(/[0-9a-f-]{36}/)

  await store.save({ jwt: 'jwt-two' })
  await store.clear()
  const raw = JSON.parse(await io.readText('C:/u/.claude/cc-glm-web-search/token.json'))
  expect(raw.deviceMid).toBe(mid)
  expect(raw.jwt).toBe('')

  // a fresh instance reads the same device id back
  const again = new TokenStore(
    {
      ...io,
      readEnvJwt: async () => undefined,
      now: async () => 0,
    },
    { home: 'C:/u' },
  )
  expect(await again.deviceMid()).toBe(mid)
})

test('ZAI_JWT beats the token file', async () => {
  const io = files()
  const store = new TokenStore(
    {
      ...io,
      readEnvJwt: async () => '  env-jwt  ',
      now: async () => 0,
    },
    { home: 'C:/u' },
  )
  await store.save({ jwt: 'file-jwt' })
  expect(await store.read()).toBe('env-jwt')
  expect(await store.source()).toEqual({ configured: true, source: 'environment (ZAI_JWT)' })
})

// ---------- the session end to end ----------

test('/glm answers status, unknown and logout with no credential', async ($, on) => {
  mock.clock(on)
  mock.env(on, { ZAI_JWT: '' })

  // /glm with no credential answers "not signed in" without reaching the net
  const status = await $.command.run({ command: 'glm', args: 'status' })
  expect(status.text).toContain('not signed in')

  const unknown = await $.command.run({ command: 'glm', args: 'wat' })
  expect(unknown.text).toContain('Usage: /glm')

  const logout = await $.command.run({ command: 'glm', args: 'logout' })
  expect(logout.text).toContain('No stored Z.AI credential to remove')
})

// ---------- the status view (the quota bars) ----------

test('statusView draws the plan, the quota bars and the refill cycle', () => {
  const now = Date.parse('2026-10-11T12:00:00+08:00')
  const view = statusView({
    state: {
      configured: true,
      email: 'you@example.com',
      tokenExpiresAt: now + 30 * 60_000,
      tokenExpired: false,
    },
    billing: {
      plans: [{ name: 'ZCode Start Plan', status: 'active', endsAt: now + 3 * 86_400_000 }],
      quotas: [
        { name: 'GLM-5.3', remaining: 2_950_000, total: 3_000_000, periodStart: now + 2 * 3600_000 - 24 * 3600_000, periodEnd: now + 2 * 3600_000 },
        { name: 'GLM-5.3-Flash', remaining: 1_000_000, total: 1_000_000, periodStart: now + 2 * 3600_000 - 24 * 3600_000, periodEnd: now + 2 * 3600_000 },
      ],
    },
    now,
  })

  const lines = view.split('\n')
  expect(lines[0]).toBe('account  you@example.com')
  expect(lines[1]).toContain('token valid 30m')
  expect(view).toContain('plan     ZCode Start Plan [active]')
  // the GLM-5.3 bar is drawn by remaining, never by used
  expect(view).toContain('quota    GLM-5.3')
  expect(view).toContain('98%')
  expect(view).toContain('2.95M/3M')
  expect(view).toContain('resets 2h 0m')
  // a full bucket reads "full", not a 100% bar
  expect(view).toContain('GLM-5.3-Flash  ██████████ full')
  expect(view).toContain('daily grant, refills at 00:00 Asia/Shanghai')
})

test('statusSummary is the one status line', () => {
  const now = 1_000_000
  const summary = statusSummary({
    state: { configured: true, tokenExpiresAt: now + 30 * 60_000, tokenExpired: false },
    billing: {
      plans: [{ name: 'ZCode Start Plan' }],
      quotas: [{ name: 'GLM-5.3', remaining: 2_950_000, total: 3_000_000, periodEnd: now + 2 * 3600_000 }],
    },
    now,
  })
  expect(summary).toBe('token 30m · Start Plan · GLM-5.3 2.95M left · resets 2h 0m')
})

test('statusSummary flags a nearly-spent bucket and a missing credential', () => {
  const now = 0
  const low = statusSummary({
    state: { configured: true },
    billing: {
      plans: [{ name: 'ZCode Start Plan' }],
      quotas: [{ name: 'GLM-5.3', remaining: 100_000, total: 1_000_000 }],
    },
    now,
  })
  expect(low).toContain('GLM-5.3 100K left LOW')

  expect(statusSummary({ state: { configured: false }, now })).toBe('not signed in')
  expect(statusSummary({ state: { configured: true }, error: 'HTTP 500', now })).toContain('plan unavailable')
})

test('logoutView names the removed source, or says there was none', () => {
  expect(logoutView({ configured: false })).toBe('No stored Z.AI credential to remove.')
  const view = logoutView({ configured: true, source: 'token file' })
  expect(view.split('\n')[0]).toBe('✓ signed out · token file removed')
  expect(view).toContain('/glm login')
})

test('the logout row revokes, then confirms', async ($, on) => {
  mock.clock(on)
  mock.env(on, { ZAI_JWT: 'jwt-in-env' })

  const answered = await $.command.run({ command: 'glm-logout' })
  expect(answered.text.split('\n')[0]).toBe('✓ signed out · environment (ZAI_JWT) removed')

  // the drawing confirms it in the success colour, with the body under it
  const ui = await $.ui.mount({
    plugin: 'cc-glm-web-search',
    surface: 'terminal',
    component: 'CommandOutput',
    requestId: 'logout-row',
    props: { command: 'glm-logout', args: '', text: answered.text, isErrored: false },
  })
  const line = await ui.find({ type: 'Text', text: /signed out/ })
  expect(line).toBeDefined()
  expect(String((await ui.find({ type: 'Text', text: /missing credential/ }))?.text)).toBeDefined()
  await ui.unmount()
})

test('the standalone aliases answer their own action', async ($, on) => {
  mock.clock(on)
  mock.env(on, { ZAI_JWT: '' })

  expect((await $.command.run({ command: 'glm-status' })).text).toContain('not signed in')
  expect((await $.command.run({ command: 'glm-logout' })).text).toContain('No stored Z.AI credential')
})

test('/glm-status draws a live row that ticks', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { ZAI_JWT: 'jwt-in-env' })

  let fetches = 0
  on('http.fetch', ($, e) => {
    fetches += 1
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({
          code: 0,
          data: {
            plans: [{ name: 'ZCode Start Plan', status: 'active' }],
            balances: [
              {
                show_name: 'GLM-5.3',
                remaining_units: 2_950_000,
                total_units: 3_000_000,
                // a window that closes inside the minute, so the reset
                // countdown redraws every second
                period_end: Math.floor((clock.now() + 90_000) / 1000),
              },
            ],
          },
        }),
      },
    }
  })

  const status = await $.command.run({ command: 'glm-status' })
  expect(status.text).toContain('quota    GLM-5.3')
  expect(fetches).toBe(1)

  // the row owns its command's output, and its text moves with the clock
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'cc-glm-web-search',
      surface,
      component: 'CommandOutput',
      requestId: 'row-1',
      props: { command: 'glm-status', args: '', text: status.text, isErrored: false },
    })
    const first = await ui.find({ type: 'Text', text: /GLM-5\.3/ })
    expect(first).toBeDefined()
    // the row carries a live reset timer with its seconds showing
    expect(String(first?.text)).toMatch(/GLM-5\.3 2\.95M left · resets \d+m \d\ds/)
    await ui.unmount()

    // a second on, the same row is drawn again with a second less: this is
    // what the session's one-second ticker does for a mounted row
    await clock.advance(1_000)
    const ui2 = await $.ui.mount({
      plugin: 'cc-glm-web-search',
      surface,
      component: 'CommandOutput',
      requestId: 'row-1',
      props: { command: 'glm-status', args: '', text: status.text, isErrored: false },
    })
    const later = await ui2.find({ type: 'Text', text: /GLM-5\.3/ })
    expect(String(later?.text)).not.toBe(String(first?.text))
    await ui2.unmount()
  }
})

test('the live row keeps the command\'s detail view under it', async ($, on) => {
  mock.clock(on)
  mock.env(on, { ZAI_JWT: 'jwt-in-env' })

  on('http.fetch', ($, e) => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({
        code: 0,
        data: {
          plans: [{ name: 'ZCode Start Plan', status: 'active' }],
          balances: [
            { show_name: 'GLM-5.3', remaining_units: 3_000_000, total_units: 3_000_000 },
            { show_name: 'GLM-5.3-Flash', remaining_units: 1_000_000, total_units: 1_000_000 },
          ],
        },
      }),
    },
  }))

  const status = await $.command.run({ command: 'glm-status' })
  // what the command answered is the whole view
  expect(status.text).toContain('account')
  expect(status.text).toContain('quota    GLM-5.3')

  // and the drawing shows it: the live first line, then the detail below
  const ui = await $.ui.mount({
    plugin: 'cc-glm-web-search',
    surface: 'terminal',
    component: 'CommandOutput',
    requestId: 'row-3',
    props: { command: 'glm-status', args: '', text: status.text, isErrored: false },
  })

  expect(String((await ui.find({ type: 'Text', text: /Z\.AI · Start Plan/ }))?.text)).toBeDefined()
  expect(String((await ui.find({ type: 'Text', text: /account/ }))?.text)).toContain('token')
  expect(String((await ui.find({ type: 'Text', text: /plan     ZCode Start Plan/ }))?.text)).toBeDefined()
  expect(String((await ui.find({ type: 'Text', text: /quota    GLM-5\.3 / }))?.text)).toBeDefined()
  expect(String((await ui.find({ type: 'Text', text: /cycle    daily grant/ }))?.text)).toBeDefined()
  await ui.unmount()
})

test('the login row waits with a spinner and its countdown ticking', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { ZAI_JWT: '' })

  on('http.fetch', ($, e) => {
    if (String(e.url).includes('/oauth/cli/init')) {
      return {
        value: {
          status: 200,
          ok: true,
          headers: {},
          text: JSON.stringify({
            code: 0,
            data: {
              flow_id: 'flow-1',
              poll_token: 'pt',
              authorize_url:
                'https://chat.z.ai/auth?client_id=client_P8X5CMWmlaRO9gyO-KSqtg&redirect_uri=x&response_type=code&state=y',
              expires_at: Math.floor((clock.now() + 300_000) / 1000),
            },
          }),
        },
      }
    }
    // the poll never answers ready, so the row stays in its waiting state
    return {
      value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ code: 0, data: { status: 'pending' } }) },
    }
  })

  const prompted = await $.command.run({ command: 'glm-login' })
  // the row's live first line is drawn by the hook, so the printed text is
  // the instruction for whichever path the browser took
  expect(prompted.text).toMatch(/approve the login in your browser|waiting for approval/)

  const ui = await $.ui.mount({
    plugin: 'cc-glm-web-search',
    surface: 'terminal',
    component: 'CommandOutput',
    requestId: 'login-row',
    props: { command: 'glm-login', args: '', text: prompted.text, isErrored: false },
  })

  const spinLine = await ui.find({ type: 'Text', text: /waiting for browser approval · \d+m \d\ds left/ })
  expect(spinLine).toBeDefined()
  await ui.unmount()

  // a second on, the same row is drawn with a second less
  await clock.advance(1_000)
  const ui2 = await $.ui.mount({
    plugin: 'cc-glm-web-search',
    surface: 'terminal',
    component: 'CommandOutput',
    requestId: 'login-row',
    props: { command: 'glm-login', args: '', text: prompted.text, isErrored: false },
  })
  const later = await ui2.find({ type: 'Text', text: /waiting for browser approval · \d+m \d\ds left/ })
  expect(String(later?.text)).not.toBe(String(spinLine?.text))
  await ui2.unmount()
})

test('the login row after approval drops the waiting instructions', async ($, on) => {
  mock.clock(on)
  mock.env(on, { ZAI_JWT: 'jwt-in-env' })

  on('http.fetch', ($, e) => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({
        code: 0,
        data: {
          plans: [{ name: 'ZCode Start Plan' }],
          balances: [{ show_name: 'GLM-5.3', remaining_units: 3_000_000, total_units: 3_000_000 }],
        },
      }),
    },
  }))
  // a signed-in view is on hand, as it is a moment after the browser approves
  await $.command.run({ command: 'glm-status' })

  const ui = await $.ui.mount({
    plugin: 'cc-glm-web-search',
    surface: 'terminal',
    component: 'CommandOutput',
    requestId: 'login-done',
    // what glm-login printed while it waited: without a pending login in
    // state, the row draws its signed-in form instead
    props: {
      command: 'glm-login',
      args: '',
      text: 'waiting for approval…\n\n  approve it in the browser window that just opened.\n\n  the window closes in 5m.',
      isErrored: false,
    },
  })

  expect(await ui.find({ type: 'Text', text: /signed in/ })).toBeDefined()
  // the stale instruction is gone: no drawn element carries it
  expect(await ui.find({ type: 'Text', text: /the window closes/ })).toBeUndefined()
  await ui.unmount()
})

test('/glm logout takes the live row down', async ($, on) => {
  mock.clock(on)
  mock.env(on, { ZAI_JWT: 'jwt-in-env' })

  on('http.fetch', ($, e) => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({ code: 0, data: { plans: [{ name: 'ZCode Start Plan' }], balances: [] } }),
    },
  }))

  await $.command.run({ command: 'glm-status' })
  await $.command.run({ command: 'glm-logout' })

  const ui = await $.ui.mount({
    plugin: 'cc-glm-web-search',
    surface: 'terminal',
    component: 'CommandOutput',
    requestId: 'row-2',
    props: { command: 'glm-status', args: '', text: '', isErrored: false },
  })
  expect(await ui.find({ type: 'Text', text: /GLM-5\.3/ })).toBeUndefined()
  await ui.unmount()
})

test('glm_vision names the gateway limit instead of blaming the image', async ($, on) => {
  mock.clock(on)
  mock.env(on, { ZAI_JWT: 'jwt-in-env' })

  // the gateway's answer when it declines image input, whatever the picture
  on('http.fetch', ($, e) => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({ code: 1210, msg: '[1210][图片输入格式/解析错误]' }),
    },
  }))

  const ran = await $.tool.call({ tool: 'mcp__cc-glm-web-search__glm_vision', image: 'https://example.invalid/a.png' })
  expect(ran.isError).toBe(true)
  expect(String(ran.result)).toContain('does not accept image input')
})

test('an empty search query is denied, a bad fetch url is denied', async ($, on) => {
  mock.clock(on)
  mock.env(on, { ZAI_JWT: '' })

  const ran = await $.tool.call({ tool: 'mcp__cc-glm-web-search__glm_web_search', query: '   ' })
  expect(ran.deny).toContain('must not be empty')

  const fetched = await $.tool.call({ tool: 'mcp__cc-glm-web-search__glm_web_fetch', url: 'not a url' })
  expect(fetched.deny).toContain('not an absolute HTTP(S) URL')
})

test('a missing credential is an error the model reads, not a crash', async ($, on) => {
  mock.clock(on)
  mock.env(on, { ZAI_JWT: '' })

  const ran = await $.tool.call({ tool: 'mcp__cc-glm-web-search__glm_web_search', query: 'anything' })
  expect(ran.isError).toBe(true)
  expect(String(ran.result)).toContain('no Z.AI credential is configured')
})
