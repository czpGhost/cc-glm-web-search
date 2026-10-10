/**
 * Z.AI OAuth device login and the local token store for the hooks
 * environment: files through `$.fs`, the poll loop driven by the caller's
 * clock, ids through crypto.
 */
import { ZCODE_OAUTH_CLIENT_ID, ZCODE_DEFAULT_ORIGIN } from './zai.ts'
import type { FetchLike } from './zai.ts'

export const TOKEN_TTL_MS = 60 * 60 * 1000

const DEFAULT_POLL_INTERVAL_MS = 3000

export class LoginError extends Error {
  code: string

  constructor(message: string, code = 'LOGIN_FAILED') {
    super(message)
    this.name = 'LoginError'
    this.code = code
  }
}

export type LoginFlow = {
  flowId: string
  pollToken: string
  authorizeUrl: string
  pollIntervalMs: number
  expiresAt: number
}

export type LoginOutcome = {
  jwt: string
  userId?: string
  name?: string
  email?: string
}

export type AuthDeps = {
  fetchImpl: FetchLike
  now: () => Promise<number>
}

function normalizeOrigin(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new LoginError(`${label} must be an absolute URL`, 'INVALID_ORIGIN')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LoginError(`${label} must use HTTP or HTTPS`, 'INVALID_ORIGIN')
  }
  return url.origin
}

async function readJson(response: { text: string }): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(response.text) as Record<string, any>
  } catch {
    return null
  }
}

/** Opens the OAuth device flow: one POST, an authorize URL to open. */
export async function initLogin(deps: AuthDeps, options: { origin?: string } = {}): Promise<LoginFlow> {
  const base = normalizeOrigin(options.origin ?? ZCODE_DEFAULT_ORIGIN, 'origin')
  const state = randomHexState()

  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await deps.fetchImpl(`${base}/api/v1/oauth/cli/init`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${state}`,
      },
      body: JSON.stringify({ provider: 'zai' }),
    })
  } catch (error) {
    throw new LoginError(
      `could not reach the Z.AI login endpoint: ${error instanceof Error ? error.message : String(error)}`,
      'LOGIN_UNREACHABLE',
    )
  }

  const payload = await readJson(response)
  const data = payload?.data
  if (!response.ok || payload?.code !== 0 || !data?.flow_id || !data?.authorize_url) {
    throw new LoginError(payload?.msg || `login init failed (HTTP ${response.status})`, 'LOGIN_INIT_FAILED')
  }

  const authorizeUrl = String(data.authorize_url)
  if (!authorizeUrl.includes(ZCODE_OAUTH_CLIENT_ID)) {
    throw new LoginError('authorize URL is missing the expected OAuth client id', 'LOGIN_INIT_FAILED')
  }

  const now = await deps.now()
  return {
    flowId: String(data.flow_id),
    pollToken: String(data.poll_token ?? state),
    authorizeUrl,
    pollIntervalMs:
      Number.isFinite(data.poll_interval_sec) && data.poll_interval_sec > 0
        ? data.poll_interval_sec * 1000
        : DEFAULT_POLL_INTERVAL_MS,
    expiresAt:
      Number.isFinite(data.expires_at) && data.expires_at > 0 ? data.expires_at * 1000 : now + 5 * 60_000,
  }
}

function randomHexState(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export type PollOutcome =
  | { phase: 'pending' }
  | { phase: 'failed'; message: string }
  | ({ phase: 'ready' } & LoginOutcome)

/** One poll of the device flow; a network error reads as "not yet". */
export async function pollLogin(deps: AuthDeps, flow: LoginFlow, options: { origin?: string } = {}): Promise<PollOutcome> {
  const base = normalizeOrigin(options.origin ?? ZCODE_DEFAULT_ORIGIN, 'origin')

  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await deps.fetchImpl(
      `${base}/api/v1/oauth/cli/poll/${encodeURIComponent(flow.flowId)}`,
      { headers: { accept: 'application/json', authorization: `Bearer ${flow.pollToken}` } },
    )
  } catch {
    return { phase: 'pending' }
  }

  const payload = await readJson(response)
  if (payload?.code !== 0) return { phase: 'pending' }

  const status = payload?.data?.status
  if (status === 'failed' || status === 'denied') {
    return { phase: 'failed', message: payload.msg || 'authorization was rejected' }
  }
  if (status !== 'ready') return { phase: 'pending' }

  const jwt = String(payload?.data?.token ?? '').trim()
  if (jwt.length === 0) return { phase: 'pending' }

  return {
    phase: 'ready',
    jwt,
    userId: payload?.data?.user?.user_id,
    name: payload?.data?.user?.name,
    email: payload?.data?.user?.email,
  }
}

// ---- credential resolution order: ZAI_JWT -> token file ----

export type TokenRecord = {
  jwt: string
  savedAt: number
  email?: string
  userId?: string
  deviceMid?: string
}

/** The token file: `<home>/.claude/cc-glm-web-search/token.json`. */
export function tokenPathFor(home: string): string {
  const base = home.replace(/[\\/]+$/, '')
  return base ? `${base}/.claude/cc-glm-web-search/token.json` : '.claude/cc-glm-web-search/token.json'
}

export type TokenStoreDeps = {
  readText: (path: string) => Promise<string>
  writeText: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  /** The ZAI_JWT variable, read by the caller ($.env.get takes literals). */
  readEnvJwt: () => Promise<string | undefined>
  now: () => Promise<number>
}

export class TokenStore {
  private path: string
  private deps: TokenStoreDeps
  private cache: string | undefined
  private record: TokenRecord | undefined

  constructor(deps: TokenStoreDeps, options: { home?: string } = {}) {
    this.path = tokenPathFor(options.home ?? '')
    this.deps = deps
  }

  get tokenPath(): string {
    return this.path
  }

  async readRecord(): Promise<TokenRecord | undefined> {
    if (this.record) return this.record
    if (!(await this.deps.exists(this.path))) return undefined
    try {
      const text = await this.deps.readText(this.path)
      if (!text) return undefined
      const parsed = JSON.parse(text) as Partial<TokenRecord>
      if (typeof parsed.jwt !== 'string' || parsed.jwt.trim().length === 0) return undefined
      this.record = {
        jwt: parsed.jwt,
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
        ...(typeof parsed.email === 'string' ? { email: parsed.email } : {}),
        ...(typeof parsed.userId === 'string' ? { userId: parsed.userId } : {}),
        ...(typeof parsed.deviceMid === 'string' ? { deviceMid: parsed.deviceMid } : {}),
      }
      return this.record
    } catch {
      return undefined
    }
  }

  /** The JWT: ZAI_JWT first, then the token file. */
  async read(): Promise<string | undefined> {
    const fromEnv = (await this.deps.readEnvJwt())?.trim()
    if (fromEnv) return fromEnv
    if (this.cache) return this.cache
    const record = await this.readRecord()
    const token = record?.jwt.trim()
    if (token) {
      this.cache = token
      return token
    }
    return undefined
  }

  /** The device id as the file holds it, whatever the JWT there is worth. */
  private async rawDeviceMid(): Promise<string | undefined> {
    if (!(await this.deps.exists(this.path))) return undefined
    try {
      const raw = await this.deps.readText(this.path)
      const parsed = raw ? (JSON.parse(raw) as Partial<TokenRecord>) : undefined
      const mid = parsed?.deviceMid
      return typeof mid === 'string' && mid.trim().length > 0 ? mid.trim() : undefined
    } catch {
      return undefined
    }
  }

  async save(outcome: LoginOutcome): Promise<void> {
    const deviceMid = await this.rawDeviceMid()
    const now = await this.deps.now()
    const record: TokenRecord = {
      jwt: outcome.jwt,
      savedAt: now,
      ...(outcome.email ? { email: outcome.email } : {}),
      ...(outcome.userId ? { userId: outcome.userId } : {}),
      ...(deviceMid ? { deviceMid } : {}),
    }
    await this.deps.writeText(this.path, `${JSON.stringify(record, null, 2)}\n`)
    this.record = record
    this.cache = outcome.jwt
  }

  /** Empties the credential, keeping the device id if one is stored. */
  async clear(): Promise<void> {
    this.cache = undefined
    this.record = undefined
    if (!(await this.deps.exists(this.path))) return

    const deviceMid = await this.rawDeviceMid()
    if (deviceMid) {
      const keep: TokenRecord = { jwt: '', savedAt: 0, deviceMid }
      await this.deps.writeText(this.path, `${JSON.stringify(keep, null, 2)}\n`)
      return
    }
    await this.deps.writeText(this.path, '')
  }

  /** A stable per-device id the gateway asks for; generated once, kept. */
  async deviceMid(): Promise<string> {
    const existing = await this.rawDeviceMid()
    if (existing) return existing

    const generated = crypto.randomUUID()
    try {
      let record: Record<string, unknown> = { deviceMid: generated }
      const rawMid = await this.rawDeviceMid()
      if (rawMid) {
        // a fresh id was stored between the two reads; keep that one
        return rawMid
      }
      if (await this.deps.exists(this.path)) {
        const raw = await this.deps.readText(this.path)
        try {
          record = { ...(JSON.parse(raw) as Record<string, unknown>), deviceMid: generated }
        } catch {
          // a malformed file is replaced by the fresh record
        }
      }
      await this.deps.writeText(this.path, `${JSON.stringify(record, null, 2)}\n`)
    } catch {
      // a read-only host still gets a stable id for this session
    }
    return generated
  }

  async source(): Promise<{ configured: boolean; source?: string; email?: string }> {
    const fromEnv = (await this.deps.readEnvJwt())?.trim()
    if (fromEnv) return { configured: true, source: 'environment (ZAI_JWT)' }
    const record = await this.readRecord()
    if (record?.jwt.trim()) {
      return { configured: true, source: 'token file', ...(record.email ? { email: record.email } : {}) }
    }
    return { configured: false }
  }

  /**
   * Whether the stored credential is past its one-hour TTL, judged by the
   * save time (the JWT's own iat claim is not decoded here).
   */
  async isExpired(): Promise<boolean> {
    const record = await this.readRecord()
    if (!record) return false
    const issuedAt = record.savedAt
    if (!issuedAt) return false
    return (await this.deps.now()) > issuedAt + TOKEN_TTL_MS
  }

  /** When the credential was stored, for the token-validity cell. */
  async issuedAt(): Promise<number | undefined> {
    const record = await this.readRecord()
    return record?.savedAt || undefined
  }
}

// ---- URL integrity ----

export const REQUIRED_AUTHORIZE_PARAMS = ['client_id', 'redirect_uri', 'response_type', 'state']

export function checkAuthorizeUrl(url: string): { ok: boolean; missing: string[] } {
  if (typeof url !== 'string' || url.length === 0) {
    return { ok: false, missing: [...REQUIRED_AUTHORIZE_PARAMS] }
  }
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  const present = new Set(
    query
      .split('&')
      .map(part => part.split('=')[0]?.trim() ?? '')
      .filter(name => name.length > 0),
  )
  const missing = REQUIRED_AUTHORIZE_PARAMS.filter(name => !present.has(name))
  return { ok: missing.length === 0, missing }
}
