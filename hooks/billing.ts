/**
 * The Z.AI billing endpoint reader for the hooks environment.
 */
import { ZCODE_DEFAULT_ORIGIN } from './zai.ts'
import type { FetchLike } from './zai.ts'
import type { Billing, Entitlement, Plan, Quota } from '../types'

export class BillingError extends Error {
  code: string

  constructor(message: string, code = 'BILLING_ERROR') {
    super(message)
    this.name = 'BillingError'
    this.code = code
  }
}

export async function fetchBilling(
  deps: { fetchImpl: FetchLike },
  options: {
    token: string
    origin?: string
    appVersion?: string
    deviceMid?: string
  },
): Promise<Billing> {
  const { token, appVersion, deviceMid } = options
  if (!token) throw new BillingError('no credential is stored', 'ZAI_CREDENTIAL_MISSING')

  const base = (options.origin ?? ZCODE_DEFAULT_ORIGIN).replace(/\/+$/, '')
  const query = appVersion ? `?app_version=${encodeURIComponent(appVersion)}` : ''

  let response: Awaited<ReturnType<FetchLike>>
  try {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'x-device-mid': deviceMid ?? crypto.randomUUID(),
    }
    if (appVersion) {
      headers['user-agent'] = `ZCode/${appVersion}`
      headers['x-zcode-app-version'] = appVersion
      headers['x-title'] = 'Z Code@electron'
    }
    response = await deps.fetchImpl(`${base}/api/v1/zcode-plan/billing/balance${query}`, { headers })
  } catch (error) {
    throw new BillingError(
      `could not reach the Z.AI billing endpoint: ${error instanceof Error ? error.message : String(error)}`,
      'BILLING_UNREACHABLE',
    )
  }

  if (response.status === 401) {
    throw new BillingError('the Z.AI credential is no longer valid', 'ZAI_UNAUTHENTICATED')
  }

  let payload: any
  try {
    payload = JSON.parse(response.text) as any
  } catch {
    throw new BillingError(
      `the billing endpoint returned HTTP ${response.status} with no JSON body`,
      'BILLING_MALFORMED',
    )
  }

  const businessCode = typeof payload?.code === 'number' ? payload.code : undefined
  if (businessCode === 1006) {
    throw new BillingError('the Z.AI credential is no longer valid', 'ZAI_UNAUTHENTICATED')
  }
  if (businessCode !== undefined && businessCode !== 0) {
    throw new BillingError(payload?.msg || `billing lookup failed (code ${businessCode})`, 'BILLING_UPSTREAM_ERROR')
  }
  if (!response.ok) {
    throw new BillingError(`the billing endpoint returned HTTP ${response.status}`, 'BILLING_UPSTREAM_ERROR')
  }

  const plans: Plan[] = (payload?.data?.plans ?? []).map((plan: any) => ({
    name: plan.name ?? plan.plan_id ?? 'unknown',
    ...(plan.plan_id ? { planId: String(plan.plan_id) } : {}),
    ...(plan.status ? { status: String(plan.status) } : {}),
    ...(plan.description ? { description: String(plan.description) } : {}),
    ...(Number.isFinite(plan.ends_at) ? { endsAt: plan.ends_at * 1000 } : {}),
    ...(Number.isFinite(plan.starts_at) ? { startsAt: plan.starts_at * 1000 } : {}),
    entitlements: (plan.entitlements ?? []).map((entry: any): Entitlement => ({
      showName: entry.show_name ?? '',
      period: entry.period ?? '',
      ...(entry.unit_type ? { unitType: String(entry.unit_type) } : {}),
      grantUnits: Number(entry.grant_units ?? 0),
      ...(entry.entitlement_id ? { entitlementId: String(entry.entitlement_id) } : {}),
    })),
  }))

  const quotas: Quota[] = (payload?.data?.balances ?? []).map((entry: any): Quota => ({
    name: entry.show_name ?? 'unknown',
    remaining: Number(entry.remaining_units ?? 0),
    total: Number(entry.total_units ?? 0),
    ...(entry.plan_id ? { planId: String(entry.plan_id) } : {}),
    ...(entry.entitlement_id ? { entitlementId: String(entry.entitlement_id) } : {}),
    ...(Number.isFinite(entry.expires_at) ? { expiresAt: entry.expires_at * 1000 } : {}),
    ...(Number.isFinite(entry.period_end) ? { periodEnd: entry.period_end * 1000 } : {}),
    ...(Number.isFinite(entry.period_start) ? { periodStart: entry.period_start * 1000 } : {}),
  }))

  return {
    plans,
    quotas,
    ...(Number.isFinite(payload?.data?.server_time) ? { serverTime: payload.data.server_time * 1000 } : {}),
  }
}
