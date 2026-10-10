export type Entitlement = {
  showName: string
  period: string
  unitType?: string
  grantUnits: number
  entitlementId?: string
}

export type Quota = {
  name: string
  remaining: number
  total: number
  planId?: string
  entitlementId?: string
  periodStart?: number
  periodEnd?: number
  expiresAt?: number
}

export type Plan = {
  name: string
  planId?: string
  status?: string
  description?: string
  endsAt?: number
  startsAt?: number
  entitlements?: Entitlement[]
}

export type Billing = {
  plans: Plan[]
  quotas: Quota[]
  serverTime?: number
}

/** The credential's state as the status view reads it. */
export type StatusState = {
  configured: boolean
  email?: string
  source?: string
  issuedAt?: number
  tokenExpiresAt?: number
  tokenExpired: boolean
  tokenRejected?: boolean
}

/** The last read of the credential and the plan, the live rows draw from. */
export type LiveView = {
  state: StatusState
  billing?: Billing
  error?: string
}

/** Where the browser login stands, the login row draws from. */
export type LoginView = {
  state: 'pending' | 'authorized' | 'failed'
  email?: string
  error?: string
  expiresAt?: number
}

/** Where the sign-out stands, the logout row draws from. */
export type LogoutView = {
  state: 'revoking' | 'done' | 'nothing'
  source?: string
}

declare module 'claude-code' {
  interface PluginState {
    'cc-glm-web-search': {
      /** The animation frame: a timer bumps it and the live rows redraw. */
      frame: number
      view: LiveView | null
      login: LoginView | null
      logout: LogoutView | null
    }
  }
}
