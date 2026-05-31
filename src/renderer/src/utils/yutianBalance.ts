export const YUTIAN_BALANCE_WARNING = '余额不足，请充值'
export const YUTIAN_PROVIDER_KEY = 'yutian-ai'

const ACCOUNT_BALANCE_KEYS = [
  'quota',
  'remain_quota',
  'remaining_quota',
  'points',
  'point',
  'credits',
  'credit',
  'tokens',
  'token_balance',
  'balance',
]

export function getYutianNumber(
  user: YutianUserInfo | null | undefined,
  keys: string[]
): number | undefined {
  if (!user) return undefined
  for (const key of keys) {
    const value = user[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      return Number(value)
    }
  }
  return undefined
}

function normalizeBalance(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  return value < 0 ? 0 : value
}

export function getYutianRemainingBalance(
  user: YutianUserInfo | null | undefined
): number | undefined {
  return normalizeBalance(getYutianNumber(user, ACCOUNT_BALANCE_KEYS))
}

export function hasInsufficientYutianBalance(user: YutianUserInfo | null | undefined): boolean {
  const remaining = getYutianRemainingBalance(user)
  return remaining !== undefined && remaining <= 0
}

export function isYutianModelRef(modelRef: string | null | undefined): boolean {
  return Boolean(modelRef && (modelRef.startsWith('yutian-') || modelRef.startsWith('yutian/')))
}
