import { readConfig } from '../config'
import { createLogger } from '../logger'
import { proxyFetch } from '../utils/proxy'

const log = createLogger('feishu-peer-resolver')

const REQUEST_TIMEOUT_MS = 12_000
const TENANT_TOKEN_TTL_MS = 90 * 60_000
const PEER_CACHE_TTL_MS = 10 * 60_000

export interface FeishuPeerLookupInput {
  kind?: 'user' | 'chat'
  id: string
}

export interface FeishuPeerLookupResult {
  id: string
  kind: 'user' | 'chat'
  displayName?: string
  error?: string
}

interface NormalizedFeishuPeer {
  id: string
  kind: 'user' | 'chat'
}

interface FeishuConfig {
  appId?: string
  appSecret?: string
  domain?: 'feishu' | 'lark'
}

interface TenantTokenCacheEntry {
  token: string
  expireAt: number
}

interface PeerCacheEntry {
  value: FeishuPeerLookupResult
  expireAt: number
}

const tenantTokenCache = new Map<string, TenantTokenCacheEntry>()
const peerCache = new Map<string, PeerCacheEntry>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

function getFeishuConfig(): FeishuConfig | null {
  const cfg = readConfig()
  const feishu = cfg.channels?.feishu
  if (!isRecord(feishu)) return null
  return {
    appId: asString(feishu.appId),
    appSecret: asString(feishu.appSecret),
    domain: feishu.domain === 'lark' ? 'lark' : 'feishu',
  }
}

function getBaseUrl(domain: 'feishu' | 'lark' = 'feishu'): string {
  return domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await proxyFetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`Feishu API returned non-JSON response: HTTP ${response.status}`)
  }
}

async function getTenantAccessToken(config: FeishuConfig): Promise<string> {
  const appId = config.appId
  const appSecret = config.appSecret
  if (!appId || !appSecret) throw new Error('Feishu appId/appSecret is not configured')

  const cacheKey = `${config.domain || 'feishu'}:${appId}`
  const cached = tenantTokenCache.get(cacheKey)
  const now = Date.now()
  if (cached && cached.expireAt > now) return cached.token

  const body = await requestJson(
    `${getBaseUrl(config.domain)}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    }
  )
  if (!isRecord(body) || body.code !== 0) {
    throw new Error(asString(isRecord(body) ? body.msg : undefined) || 'Failed to get Feishu token')
  }

  const token = asString(body.tenant_access_token)
  if (!token) throw new Error('Feishu token response is missing tenant_access_token')
  tenantTokenCache.set(cacheKey, { token, expireAt: now + TENANT_TOKEN_TTL_MS })
  return token
}

function pickUserName(user: Record<string, unknown>): string | undefined {
  return asString(user.name) || asString(user.nickname) || asString(user.en_name)
}

function pickChatName(data: Record<string, unknown>): string | undefined {
  const chat = isRecord(data.chat) ? data.chat : data
  return (
    asString(chat.name) ||
    asString(chat.chat_name) ||
    asString(chat.description) ||
    asString(data.name)
  )
}

function normalizePeer(input: FeishuPeerLookupInput): NormalizedFeishuPeer | null {
  const id = input.id.trim()
  if (!id) return null
  const kind = input.kind || (id.startsWith('ou_') || id.startsWith('on_') ? 'user' : 'chat')
  return { id, kind }
}

async function resolveOnePeer(
  config: FeishuConfig,
  token: string,
  input: FeishuPeerLookupInput
): Promise<FeishuPeerLookupResult> {
  const normalized = normalizePeer(input)
  if (!normalized) return { id: input.id, kind: input.kind || 'user', error: 'empty id' }

  const cacheKey = `${config.domain || 'feishu'}:${normalized.kind}:${normalized.id}`
  const cached = peerCache.get(cacheKey)
  const now = Date.now()
  if (cached && cached.expireAt > now) return cached.value

  const baseUrl = getBaseUrl(config.domain)
  const headers = { authorization: `Bearer ${token}` }
  let result: FeishuPeerLookupResult

  if (normalized.kind === 'user') {
    const body = await requestJson(
      `${baseUrl}/open-apis/contact/v3/users/${encodeURIComponent(
        normalized.id
      )}?user_id_type=open_id`,
      { headers }
    )
    if (!isRecord(body) || body.code !== 0) {
      result = {
        ...normalized,
        error: asString(isRecord(body) ? body.msg : undefined) || 'Failed to resolve Feishu user',
      }
    } else {
      const user = isRecord(body.data) && isRecord(body.data.user) ? body.data.user : {}
      const displayName = pickUserName(user)
      result = {
        ...normalized,
        ...(displayName
          ? { displayName }
          : { error: 'Feishu user name is empty; check contact permission scopes' }),
      }
    }
  } else {
    const body = await requestJson(
      `${baseUrl}/open-apis/im/v1/chats/${encodeURIComponent(normalized.id)}`,
      { headers }
    )
    if (!isRecord(body) || body.code !== 0) {
      result = {
        ...normalized,
        error: asString(isRecord(body) ? body.msg : undefined) || 'Failed to resolve Feishu chat',
      }
    } else {
      const data = isRecord(body.data) ? body.data : {}
      const displayName = pickChatName(data)
      result = {
        ...normalized,
        ...(displayName ? { displayName } : { error: 'Feishu chat name is empty' }),
      }
    }
  }

  peerCache.set(cacheKey, { value: result, expireAt: now + PEER_CACHE_TTL_MS })
  return result
}

export async function resolveFeishuPeers(
  inputs: FeishuPeerLookupInput[]
): Promise<FeishuPeerLookupResult[]> {
  const config = getFeishuConfig()
  if (!config?.appId || !config.appSecret) {
    return inputs.map((input) => ({
      id: input.id,
      kind: input.kind || 'user',
      error: 'Feishu app is not configured',
    }))
  }

  try {
    const token = await getTenantAccessToken(config)
    const uniqueInputs = Array.from(
      new Map(
        inputs
          .map(normalizePeer)
          .filter((item): item is NormalizedFeishuPeer => Boolean(item))
          .map((item) => [`${item.kind}:${item.id}`, item])
      ).values()
    )
    return await Promise.all(uniqueInputs.map((input) => resolveOnePeer(config, token, input)))
  } catch (err) {
    log.warn('failed to resolve Feishu peer names:', err)
    return inputs.map((input) => ({
      id: input.id,
      kind: input.kind || 'user',
      error: err instanceof Error ? err.message : String(err),
    }))
  }
}
