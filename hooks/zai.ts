/**
 * The Z.AI ZCode gateway protocol for the Claude Code hooks environment:
 * fetch goes through `$.http.fetch` (no abort signal, so timeouts race a
 * clock sleep), ids through crypto.randomUUID.
 */

export const IDENTITY_HEAD = 'You are ZCode, an interactive coding agent'

export const AGENT_PROMPT_PREFIX =
  '\nYou are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\n# Harness\n- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don\'t retry verbatim.\n- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.\n- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n- Reference code as `file_path:line_number` — it\'s clickable.'

export const FALLBACK_APP_VERSION = '3.14.3'

export const ZCODE_DEFAULT_ORIGIN = 'https://zcode.z.ai'

export const ZCODE_OAUTH_CLIENT_ID = 'client_P8X5CMWmlaRO9gyO-KSqtg'

export const TOOL_WEB_SEARCH = 'web_search_20250305'

export const TOOL_WEB_FETCH = 'web_fetch_20250910'

export const FALLBACK_MODEL = 'GLM-5.3'

export const FALLBACK_VISION_MODEL = 'GLM-5.3-Flash'

const CODE_IDENTITY_REJECTED = 3012
const CONCURRENCY_CODES = new Set([3008, 3009, 3010])
const MAX_ATTEMPTS = 4
const RETRY_BASE_MS = 2000

export class ZaiError extends Error {
  code: string
  status?: number
  businessCode?: number

  constructor(message: string, options: { code?: string; status?: number; businessCode?: number } = {}) {
    super(message)
    this.name = 'ZaiError'
    this.code = options.code ?? 'ZAI_ERROR'
    if (options.status !== undefined) this.status = options.status
    if (options.businessCode !== undefined) this.businessCode = options.businessCode
  }
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; headers: Record<string, string>; text: string }>

export type ZaiClientDeps = {
  fetchImpl: FetchLike
  /**
   * Waits `ms` and resolves. Must NOT be `$.clock.sleep`: that pays out of
   * the hook's own budget, which is ten seconds; this is driven by a timer
   * of the module's (`$.clock.after`), whose dispatch is its own.
   */
  wait: (ms: number) => Promise<void>
  randomId: () => string
}

export type ZaiClientOptions = {
  origin?: string
  model?: string
  appVersion?: string
  /** The `x-platform` header value, e.g. "windows-x64" or "linux-x64". */
  platform?: string
  /** The `x-os-category` header value: "windows", "macos" or "linux". */
  osCategory?: string
  resolveToken: () => Promise<string | undefined>
  deviceMid?: () => string | undefined
  timeoutMs?: number
  deps: ZaiClientDeps
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decodes what the gateway puts in a server tool's result block: a JSON array
 * (sometimes double-encoded, sometimes wrapped in `{ text }`), normalised to
 * the plain payload the mappers read.
 */
export function parseServerToolResult(content: unknown): unknown {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? null)
  if (text.length === 0) return null

  const candidates: string[] = []
  const seam = text.lastIndexOf('][')
  if (seam >= 0) candidates.push(text.slice(seam + 1))
  candidates.push(text)

  for (const candidate of candidates) {
    const parsed = tryParse(candidate)
    if (parsed === undefined) continue
    const normalized = normalizePayload(parsed, 0)
    if (normalized !== undefined) return normalized
  }
  return null
}

function normalizePayload(value: unknown, depth: number): unknown {
  if (depth > 8) return value

  if (isPlainObject(value) && 'text' in value && Object.keys(value).length <= 2) {
    const inner: unknown = value.text
    if (typeof inner === 'string') {
      const parsed = tryParse(inner)
      return normalizePayload(parsed === undefined ? inner : parsed, depth + 1)
    }
    return normalizePayload(inner, depth + 1)
  }

  if (Array.isArray(value) && value.length === 1 && Array.isArray(value[0])) {
    return normalizePayload(value[0], depth + 1)
  }

  return value
}

function pickBusinessCode(payload: unknown): number | undefined {
  if (!isPlainObject(payload)) return undefined
  if (typeof payload.code === 'number') return payload.code
  const nested = payload.error
  if (isPlainObject(nested) && typeof nested.code === 'number') return nested.code
  return undefined
}

function pickMessage(payload: unknown): string | undefined {
  if (!isPlainObject(payload)) return undefined
  for (const key of ['msg', 'message'] as const) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  const nested = payload.error
  if (isPlainObject(nested) && typeof nested.message === 'string' && nested.message.trim().length > 0) {
    return nested.message.trim()
  }
  return undefined
}

export type ToolResultBlock = { type: string; text?: unknown; content?: unknown } & Record<string, unknown>

/** The ZCode gateway client, one instance per loaded module. */
export class ZaiClient {
  origin: string
  model?: string
  appVersion?: string
  platform: string
  osCategory: string
  timeoutMs: number
  resolveToken: () => Promise<string | undefined>
  deviceMid?: () => string | undefined
  deps: ZaiClientDeps

  constructor(options: ZaiClientOptions) {
    this.origin = (options.origin ?? ZCODE_DEFAULT_ORIGIN).replace(/\/+$/, '')
    this.model = options.model
    this.appVersion = options.appVersion
    this.platform = options.platform ?? 'windows-x64'
    this.osCategory = options.osCategory ?? 'windows'
    this.timeoutMs = options.timeoutMs ?? 90_000
    this.resolveToken = options.resolveToken
    this.deviceMid = options.deviceMid
    this.deps = options.deps
  }

  get messagesUrl(): string {
    return `${this.origin}/api/v1/zcode-plan/anthropic/v1/messages`
  }

  identitySystem(...extraBlocks: { type: string; text: string }[]) {
    return [
      { type: 'text', text: IDENTITY_HEAD },
      { type: 'text', text: AGENT_PROMPT_PREFIX },
      ...extraBlocks,
    ]
  }

  /**
   * Runs one server-side tool (web_search_prime / webReader) by asking the
   * gateway's model to call it under `tool_choice`, then decoding the
   * server_tool_use/tool_result blocks of the answer.
   */
  async runServerTool(toolType: string, toolName: string, prompt: string, toolInput: Record<string, unknown>): Promise<unknown> {
    const block = {
      type: 'text',
      text: `Call the ${toolName} tool with exactly the arguments provided in the user turn. Do not answer from memory.`,
    }
    const body = {
      model: this.model ?? FALLBACK_MODEL,
      max_tokens: 1024,
      stream: false,
      system: this.identitySystem(block),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'text', text: `Tool arguments: ${JSON.stringify(toolInput)}` },
          ],
        },
      ],
      tools: [{ type: toolType, name: toolName, max_uses: 3 }],
      tool_choice: { type: 'tool', name: toolName },
      thinking: { type: 'disabled' },
    }

    const parsed = await this.request(body, toolName)

    const blocks = Array.isArray((parsed as { content?: unknown })?.content)
      ? ((parsed as { content: unknown[] }).content as ToolResultBlock[])
      : []
    const serverUse = blocks.find(entry => entry?.type === 'server_tool_use')
    const result = blocks.find(entry => entry?.type === 'tool_result')

    if (!serverUse) {
      throw new ZaiError(`the gateway did not run ${toolName}; it answered from the model instead`, {
        code: 'ZAI_TOOL_NOT_RUN',
      })
    }
    if (!result) {
      throw new ZaiError(`the gateway ran ${toolName} but returned no result`, { code: 'ZAI_EMPTY_RESULT' })
    }

    const payload = parseServerToolResult(result.content)
    if (payload === null) {
      throw new ZaiError(`the ${toolName} result could not be decoded`, { code: 'ZAI_MALFORMED_RESULT' })
    }
    if (isPlainObject(payload) && 'error' in payload) {
      throw new ZaiError(String(payload.error), { code: 'ZAI_TOOL_ERROR' })
    }
    return payload
  }

  /** A plain completion request (vision); returns the whole payload. */
  async request(body: unknown, label = 'request'): Promise<unknown> {
    const token = await this.resolveToken()
    if (!token) {
      throw new ZaiError('no Z.AI credential is configured — run /glm login', {
        code: 'ZAI_CREDENTIAL_MISSING',
      })
    }
    const version = this.appVersion ?? FALLBACK_APP_VERSION

    let lastError: ZaiError | undefined
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const outcome = await this.send(body as Record<string, unknown>, token, version)

      if (outcome.ok) return outcome.payload

      lastError = outcome.error
      const retryable = CONCURRENCY_CODES.has(outcome.error.businessCode ?? -1)
      if (!retryable || attempt === MAX_ATTEMPTS) throw outcome.error

      await this.deps.wait(RETRY_BASE_MS * attempt)
    }
    throw lastError ?? new ZaiError(`${label} failed`, { code: 'ZAI_ERROR' })
  }

  private async send(
    body: Record<string, unknown>,
    token: string,
    version: string,
  ): Promise<{ ok: true; payload: unknown } | { ok: false; error: ZaiError }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'user-agent': `ZCode/${version}`,
      'http-referer': this.origin,
      'x-title': 'Z Code@electron',
      'x-zcode-app-version': version,
      'x-platform': this.platform,
      'x-release-channel': 'stable',
      'x-client-language': 'zh-CN',
      'x-client-timezone': 'Asia/Shanghai',
      'x-os-category': this.osCategory,
      'x-request-id': this.deps.randomId(),
    }
    const mid = this.deviceMid?.()
    if (mid) headers['x-device-mid'] = mid

    // $.http.fetch carries no abort signal: the timeout is a race the loser
    // of which keeps running unawaited. The wait rides a module timer, not
    // this hook's budget (ten seconds, and a gateway request may outlast it).
    const timeoutPromise = this.deps.wait(this.timeoutMs).then(() => {
      throw new ZaiError('the request timed out', { code: 'ZAI_TIMEOUT' })
    })

    let response: { status: number; ok: boolean; headers: Record<string, string>; text: string }
    try {
      response = await Promise.race([
        this.deps.fetchImpl(this.messagesUrl, { method: 'POST', headers, body: JSON.stringify(body) }),
        timeoutPromise,
      ])
    } catch (error) {
      return {
        ok: false,
        error: new ZaiError(`could not reach the ZCode gateway: ${describe(error)}`, {
          code: 'ZAI_UNREACHABLE',
        }),
      }
    }

    const text = response.text
    const payload = tryParse(text)

    const businessCode = pickBusinessCode(payload)
    const failed =
      !response.ok ||
      payload === undefined ||
      (isPlainObject(payload) && 'error' in payload) ||
      (businessCode !== undefined && businessCode !== 0)

    if (failed) return { ok: false, error: this.mapFailure(response.status, payload, text) }
    return { ok: true, payload }
  }

  private mapFailure(status: number, payload: unknown, raw: string): ZaiError {
    const businessCode = pickBusinessCode(payload)
    const detail = pickMessage(payload) ?? String(raw ?? '').slice(0, 300).trim()

    if (businessCode === CODE_IDENTITY_REJECTED) {
      return new ZaiError(
        'the gateway rejected the ZCode client identity (code 3012). Z.AI most likely changed its client contract; the identity constants in hooks/zai.ts need re-capturing from a current ZCode build.',
        { code: 'ZAI_CLIENT_OUTDATED', status, businessCode },
      )
    }
    if (status === 405 && businessCode === undefined) {
      return new ZaiError(
        'the gateway blocked the request (HTTP 405), which is the edge WAF rate-limiting this egress IP rather than an authentication failure',
        { code: 'ZAI_BLOCKED', status, businessCode },
      )
    }
    if (businessCode === 1005) {
      return new ZaiError(detail || 'the Z.AI account has no remaining quota for this period', {
        code: 'ZAI_QUOTA_EXHAUSTED',
        status,
        businessCode,
      })
    }
    if (businessCode === 1006) {
      return new ZaiError(detail || 'the Z.AI credential is no longer valid; sign in again with /glm login', {
        code: 'ZAI_UNAUTHENTICATED',
        status,
        businessCode,
      })
    }
    if (businessCode === 3006) {
      return new ZaiError(detail || `the model "${this.model ?? FALLBACK_MODEL}" is not available on this plan`, {
        code: 'ZAI_MODEL_UNAVAILABLE',
        status,
        businessCode,
      })
    }
    if ((businessCode !== undefined && CONCURRENCY_CODES.has(businessCode)) || status === 429) {
      return new ZaiError(detail || 'the Z.AI gateway is rate limiting this account', {
        code: 'ZAI_RATE_LIMITED',
        status,
        businessCode,
      })
    }
    if (status === 401 || status === 403) {
      return new ZaiError(detail || 'the Z.AI credential was rejected', {
        code: 'ZAI_UNAUTHENTICATED',
        status,
        businessCode,
      })
    }
    return new ZaiError(detail || `the Zcode gateway returned HTTP ${status}`, {
      code: 'ZAI_UPSTREAM_ERROR',
      status,
      businessCode,
    })
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---- payload mappers ----

export type SearchSource = {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

function pickString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function pickAbsolute(value: unknown): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(String(value))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.href
  } catch {
    return undefined
  }
}

function pickUrl(item: Record<string, unknown>): string | undefined {
  const candidate = pickString(item.link) ?? pickString(item.url) ?? pickString(item.href)
  return pickAbsolute(candidate)
}

export function mapSearchResults(payload: unknown): { sources: SearchSource[]; dropped: number } {
  const items = Array.isArray(payload) ? payload : []
  const sources: SearchSource[] = []
  let dropped = 0

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      dropped += 1
      continue
    }
    const record = item as Record<string, unknown>
    const url = pickUrl(record)
    if (!url) {
      dropped += 1
      continue
    }
    const source: SearchSource = { url }
    const title = pickString(record.title)
    if (title) source.title = title
    const snippet = pickString(record.content) ?? pickString(record.snippet) ?? pickString(record.media)
    if (snippet) source.snippet = snippet
    const publishedAt = pickString(record.publish_date) ?? pickString(record.publishDate)
    if (publishedAt) source.publishedAt = publishedAt
    sources.push(source)
  }

  return { sources, dropped }
}

export type ReaderResult = { url: string; title?: string; content: string }

export function mapReaderResult(payload: unknown, requestedUrl: string): ReaderResult {
  let record: Record<string, unknown> = {}
  if (Array.isArray(payload)) {
    const first = payload.find(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
    if (first) record = first as Record<string, unknown>
  } else if (payload && typeof payload === 'object') {
    record = payload as Record<string, unknown>
  }

  const content = pickString(record.content) ?? pickString(record.text) ?? ''
  const url = pickAbsolute(pickString(record.url)) ?? requestedUrl
  const title = pickString(record.title)

  return { url, title, content }
}
