import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { session } from 'electron'
import {
  ensureYutianModelRouting,
  readConfig,
  writeConfig,
  type OpenclawConfig,
  type ProviderConfig,
} from '../config'
import { YUTIANCLAW_HOME } from '../constants'
import { createLogger } from '../logger'
import { proxyFetch } from '../utils/proxy'

const log = createLogger('yutian-account')

const ACCOUNT_STORE_PATH = join(YUTIANCLAW_HOME, 'account.json')
const ACCOUNT_SCHEMA_VERSION = 2
const YUTIAN_API_BASE = 'https://claw.yutianedu.com'
const YUTIAN_MODEL_BASE_URL = 'https://claw.yutianedu.com/v1'
const YUTIAN_MODEL_ID = 'DeepSeek-V4-Pro'
const YUTIAN_MODEL_NAME = '誉天大模型'
const YUTIAN_MODEL_TIMEOUT_SECONDS = 180
const YUTIAN_NO_API_KEY_MESSAGE = '尚未配置誉天模型秘钥'
const REQUEST_TIMEOUT_MS = 20_000
const YUTIAN_LOGIN_PATH = '/api/user/login?turnstile='
const YUTIAN_REGISTER_PATH = '/api/user/register?turnstile='
const YUTIAN_PROVIDER_KEY = 'yutian-ai'
const YUTIAN_LEGACY_PROVIDER_KEYS = [
  'yutian',
  'yutian-ou-la',
  'yutian-cangjie',
  'yutian-compute',
  'yutian-gauss',
  'yutian-harmonyos',
  'yutian-career',
]
const YUTIAN_PROVIDER_KEYS = [YUTIAN_PROVIDER_KEY, ...YUTIAN_LEGACY_PROVIDER_KEYS]

function getYutianProviderModelName(providerKey: string): string {
  void providerKey
  return YUTIAN_MODEL_NAME
}

export interface YutianUserInfo {
  id?: number | string
  username?: string
  display_name?: string
  email?: string
  group?: string
  quota?: number
  used_quota?: number
  api_key_remain_quota?: number
  api_key_used_quota?: number
  api_key_request_count?: number
  request_count?: number
  status?: number
  role?: number
  [key: string]: unknown
}

interface AccountStore {
  schemaVersion: number
  accessToken?: string
  sessionCookie?: string
  sessionAuthenticated?: boolean
  user?: YutianUserInfo
  apiKeySyncedAt?: string
  updatedAt?: string
}

export interface YutianAccountState {
  loggedIn: boolean
  user: YutianUserInfo | null
  hasAccessToken: boolean
  hasApiKey: boolean
  apiKeySyncedAt?: string
  message?: string
}

export interface YutianAuthPayload {
  username: string
  password: string
}

export interface YutianPhoneAuthPayload {
  phone: string
  code: string
}

export interface YutianSmsPayload {
  phone: string
  scene?: 'login' | 'register'
}

export interface YutianRegisterPayload extends YutianAuthPayload {
  phone?: string
  code?: string
}

interface YutianModelApiInfo {
  apiKey: string
  baseUrl: string
  modelId: string
  models: NonNullable<ProviderConfig['models']>
  userPatch: Partial<YutianUserInfo>
}

interface FetchYutianApiInfoOptions {
  preferConfiguredKey?: boolean
  allowConfiguredFallback?: boolean
}

interface FetchApiKeyFromTokenPayloadOptions {
  allowConfiguredFallback?: boolean
  fetchPlaintext?: boolean
}

interface JsonResponse {
  success?: boolean
  message?: string
  data?: unknown
  [key: string]: unknown
}

interface RequestOptions {
  method?: string
  body?: unknown
  accessAuth?: boolean
  sessionUserId?: string
  absoluteUrl?: string
}

function ensureDir(path: string): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function loadStore(): AccountStore {
  try {
    if (!existsSync(ACCOUNT_STORE_PATH)) return { schemaVersion: ACCOUNT_SCHEMA_VERSION }
    const parsed = JSON.parse(readFileSync(ACCOUNT_STORE_PATH, 'utf-8')) as AccountStore
    if (parsed.schemaVersion !== ACCOUNT_SCHEMA_VERSION) {
      return { schemaVersion: ACCOUNT_SCHEMA_VERSION }
    }
    return parsed
  } catch (err) {
    log.warn('failed to read account store:', err)
    return { schemaVersion: ACCOUNT_SCHEMA_VERSION }
  }
}

function saveStore(patch: Partial<AccountStore>): AccountStore {
  const next: AccountStore = {
    ...loadStore(),
    ...patch,
    schemaVersion: ACCOUNT_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  }
  try {
    ensureDir(ACCOUNT_STORE_PATH)
    writeFileSync(ACCOUNT_STORE_PATH, JSON.stringify(next, null, 2), 'utf-8')
  } catch (err) {
    log.warn('failed to write account store:', err)
  }
  return next
}

function clearStore(): void {
  try {
    saveStore({
      accessToken: undefined,
      sessionCookie: undefined,
      sessionAuthenticated: undefined,
      user: undefined,
      apiKeySyncedAt: undefined,
    })
  } catch (err) {
    log.warn('failed to clear account store:', err)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number') return String(value)
  return undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return undefined
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(record[key])
    if (value) return value
  }
  return undefined
}

function extractData(body: unknown): unknown {
  if (isRecord(body) && 'data' in body) return body.data
  return body
}

function extractUser(value: unknown): YutianUserInfo | null {
  const raw = extractData(value)
  const data =
    isRecord(raw) && isRecord(raw.user)
      ? raw.user
      : isRecord(raw) && isRecord(raw.info)
        ? raw.info
        : raw
  if (!isRecord(data)) return null
  const user: YutianUserInfo = { ...data }
  const id = asString(data.id ?? data.user_id ?? data.userId)
  if (id) user.id = Number.isFinite(Number(id)) ? Number(id) : id
  for (const key of [
    'quota',
    'remain_quota',
    'used_quota',
    'request_count',
    'points',
    'point',
    'tokens',
    'token_balance',
    'status',
    'role',
  ]) {
    const value = asNumber(data[key])
    if (value !== undefined) user[key] = value
  }
  return user
}

function extractArray(value: unknown): Record<string, unknown>[] {
  const data = extractData(value)
  const candidates = [
    data,
    isRecord(data) ? data.items : undefined,
    isRecord(data) ? data.list : undefined,
    isRecord(data) ? data.tokens : undefined,
    isRecord(data) ? data.records : undefined,
    isRecord(data) ? data.rows : undefined,
  ]

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord)
    }
  }
  return []
}

function extractApiKey(value: unknown): string | undefined {
  const data = extractData(value)
  if (typeof data === 'string') return normalizeModelApiKey(data)
  if (isRecord(data)) {
    const direct = pickString(data, ['key', 'api_key', 'apiKey', 'token', 'secret', 'value'])
    const key = direct ? normalizeModelApiKey(direct) : undefined
    if (key) return key
  }

  const tokens = extractArray(value)
  for (const token of tokens) {
    const status = asNumber(token.status)
    if (status !== undefined && status !== 1) continue
    const key = pickString(token, ['key', 'api_key', 'apiKey', 'token', 'secret', 'value'])
    const normalized = key ? normalizeModelApiKey(key) : undefined
    if (normalized) return normalized
  }
  return undefined
}

function normalizeModelApiKey(value: string): string | undefined {
  const key = value.trim()
  if (key.startsWith('sk-') && key.length > 20) return key
  if (/^[A-Za-z0-9_-]{32,}$/.test(key)) return `sk-${key}`
  return undefined
}

function assertSuccess(body: JsonResponse, fallback: string): void {
  if (body.success === false) {
    throw new Error(body.message || fallback)
  }
}

function isAccessTokenInvalid(body: JsonResponse): boolean {
  if (body.success !== false) return false
  const message = typeof body.message === 'string' ? body.message : ''
  return /access\s*token|访问凭证|访问令牌|无权|未登录|unauthor/i.test(message)
}

function cookieHeaderFromSetCookie(value: string): string | undefined {
  const cookies = value
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((part) => part.split(';')[0]?.trim())
    .filter((part): part is string => Boolean(part && part.includes('=')))
  return cookies.length > 0 ? cookies.join('; ') : undefined
}

function extractCookieHeader(headers: Headers): string | undefined {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] }
  const setCookies =
    typeof withGetSetCookie.getSetCookie === 'function' ? withGetSetCookie.getSetCookie() : []
  if (setCookies.length > 0) {
    return setCookies
      .map(cookieHeaderFromSetCookie)
      .filter((item): item is string => Boolean(item))
      .join('; ')
  }
  const combined = headers.get('set-cookie')
  return combined ? cookieHeaderFromSetCookie(combined) : undefined
}

async function requestJson(path: string, options: RequestOptions = {}): Promise<JsonResponse> {
  const store = loadStore()
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }

  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.accessAuth) {
    if (!store.accessToken && !store.sessionAuthenticated && !store.sessionCookie) {
      throw new Error('请先登录誉天账号')
    }
    if (store.accessToken) headers.Authorization = `Bearer ${store.accessToken}`
    if (store.sessionCookie) headers.Cookie = store.sessionCookie
    if (store.user?.id) headers['New-Api-User'] = String(store.user.id)
  } else if (options.sessionUserId) {
    headers['New-Api-User'] = options.sessionUserId
  }

  let response: Response
  const url = options.absoluteUrl || `${YUTIAN_API_BASE}${path}`
  try {
    response = await proxyFetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'include',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/ERR_HTTP2_PROTOCOL_ERROR|HTTP2_PROTOCOL_ERROR/i.test(message)) {
      log.warn(`electron net.fetch failed for ${path}, retrying with node fetch: ${message}`)
      response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: 'include',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } else {
      throw err
    }
  }
  const sessionCookie = extractCookieHeader(response.headers)
  if (sessionCookie) {
    saveStore({ sessionCookie, sessionAuthenticated: true })
  }
  const text = await response.text()
  let body: JsonResponse = {}
  if (text.trim()) {
    try {
      body = JSON.parse(text) as JsonResponse
    } catch {
      body = { success: response.ok, message: text }
    }
  }

  if (!response.ok) {
    if (response.status === 429 && path.includes('/api/verification/sms')) {
      throw new Error('短信验证码发送过于频繁，请稍后再试')
    }
    throw new Error(body.message || `誉天接口请求失败: HTTP ${response.status}`)
  }

  if (options.accessAuth && isAccessTokenInvalid(body)) {
    log.warn(`access token auth failed for ${path}, retrying with browser session cookie`)
    return await requestJson(path, { ...options, accessAuth: false })
  }

  return body
}

function getConfiguredYutianApiKey(): string | undefined {
  const providers = readConfig().models?.providers || {}
  for (const key of YUTIAN_PROVIDER_KEYS) {
    const apiKey = providers[key]?.apiKey
    if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim()
  }
  return undefined
}

function hasConfiguredYutianApiKey(): boolean {
  return Boolean(getConfiguredYutianApiKey())
}

function pickPreferredModelId(modelNames: string[]): string {
  void modelNames
  return YUTIAN_MODEL_ID
}

function normalizeYutianModelNames(modelNames: string[]): string[] {
  const unique = new Map<string, string>()
  for (const rawName of modelNames) {
    const name = rawName.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (!unique.has(key)) unique.set(key, name)
  }
  return Array.from(unique.values())
}

function extractUserPatch(value: unknown): Partial<YutianUserInfo> {
  const data = extractData(value)
  const userPatch: Partial<YutianUserInfo> = {}
  if (isRecord(data)) {
    for (const key of ['points', 'point', 'tokens', 'token_balance', 'balance']) {
      const value = asNumber(data[key])
      if (value !== undefined) userPatch[key] = value
    }
  }

  const token =
    extractArray(value).find((item) => asNumber(item.status) === 1) || extractArray(value)[0]
  if (token) {
    const quota = asNumber(token.remain_quota)
    const used = asNumber(token.used_quota)
    const requests = asNumber(token.request_count)
    if (quota !== undefined) userPatch.api_key_remain_quota = quota
    if (used !== undefined) userPatch.api_key_used_quota = used
    if (requests !== undefined) userPatch.api_key_request_count = requests
  }
  return userPatch
}

function buildYutianApiInfo(
  apiKey: string,
  modelNames: string[],
  source?: unknown
): YutianModelApiInfo {
  const names = normalizeYutianModelNames(modelNames)
  const modelId = pickPreferredModelId(names)
  return {
    apiKey,
    baseUrl: YUTIAN_MODEL_BASE_URL,
    modelId,
    models: [
      {
        id: modelId,
        name: YUTIAN_MODEL_NAME,
        input: ['text', 'image'],
      },
    ],
    userPatch: source ? extractUserPatch(source) : {},
  }
}

export async function fetchYutianModelNames(apiKey: string): Promise<string[]> {
  void apiKey
  return [YUTIAN_MODEL_ID]
}

async function listApiTokens(): Promise<JsonResponse> {
  const body = await requestJson('/api/token/', { accessAuth: true })
  assertSuccess(body, '获取誉天 API Key 列表失败')
  return body
}

function extractFirstTokenId(value: unknown): string | undefined {
  const tokens = extractArray(value)
  for (const token of tokens) {
    const status = asNumber(token.status)
    if (status !== undefined && status !== 1) continue
    const id = asString(token.id)
    if (id) return id
  }
  return undefined
}

async function fetchApiTokenKey(id: string): Promise<string | undefined> {
  const body = await requestJson(`/api/token/${encodeURIComponent(id)}/key`, {
    method: 'POST',
    accessAuth: true,
  })
  assertSuccess(body, '获取誉天 API Key 失败')
  return extractApiKey(body)
}

async function createApiToken(): Promise<JsonResponse> {
  const payload = {
    name: 'test',
    expired_time: -1,
    remain_quota: 0,
    unlimited_quota: true,
  }
  const body = await requestJson('/api/token/', {
    method: 'POST',
    accessAuth: true,
    body: payload,
  })
  assertSuccess(body, '创建誉天 API Key 失败')
  return body
}

async function fetchApiKeyFromTokenPayload(
  payload: unknown,
  options: FetchApiKeyFromTokenPayloadOptions = {}
): Promise<string | undefined> {
  const embeddedKey = extractApiKey(payload)
  if (embeddedKey) return embeddedKey
  if (options.fetchPlaintext === false) return undefined

  const tokenId = extractFirstTokenId(payload)
  if (tokenId) {
    try {
      const apiKey = await fetchApiTokenKey(tokenId)
      if (apiKey) return apiKey
    } catch (err) {
      const fallback = options.allowConfiguredFallback ? getConfiguredYutianApiKey() : undefined
      if (fallback) {
        log.warn(
          `fetch yutian api key failed, using configured key fallback: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        return fallback
      }
      throw err
    }
  }
  return undefined
}

async function fetchYutianApiInfo(
  options: FetchYutianApiInfoOptions = {}
): Promise<YutianModelApiInfo> {
  const configuredKey = getConfiguredYutianApiKey()
  const listed = await listApiTokens()
  let source: unknown = listed
  let apiKey = options.preferConfiguredKey && configuredKey ? configuredKey : undefined
  let lastKeyError: unknown

  if (!apiKey) {
    try {
      apiKey = await fetchApiKeyFromTokenPayload(listed, {
        allowConfiguredFallback: options.allowConfiguredFallback,
      })
    } catch (err) {
      lastKeyError = err
      log.warn('fetch yutian api key from token list failed:', err)
    }
  }

  if (!apiKey) {
    const created = await createApiToken()
    source = created
    apiKey = await fetchApiKeyFromTokenPayload(created, {
      allowConfiguredFallback: options.allowConfiguredFallback,
    })
  }

  if (!apiKey && configuredKey && options.allowConfiguredFallback) {
    apiKey = configuredKey
  }

  if (!apiKey) {
    try {
      const refreshed = await listApiTokens()
      source = refreshed
      apiKey = await fetchApiKeyFromTokenPayload(refreshed, {
        allowConfiguredFallback: options.allowConfiguredFallback,
      })
    } catch (err) {
      lastKeyError = err
    }
  }

  if (!apiKey && lastKeyError instanceof Error) throw lastKeyError
  if (!apiKey) throw new Error(YUTIAN_NO_API_KEY_MESSAGE)

  return buildYutianApiInfo(apiKey, [YUTIAN_MODEL_ID], source)
}

function buildYutianProviderConfig(
  providerKey: string,
  existing: ProviderConfig | undefined,
  apiInfo: YutianModelApiInfo
): ProviderConfig {
  return {
    ...(existing || {}),
    api: 'openai-completions',
    baseUrl: apiInfo.baseUrl,
    apiKey: apiInfo.apiKey,
    timeoutSeconds: YUTIAN_MODEL_TIMEOUT_SECONDS,
    models: apiInfo.models.map((model) => ({
      ...model,
      name: getYutianProviderModelName(providerKey),
    })),
  }
}

function applyYutianApiKey(apiInfo: YutianModelApiInfo): void {
  const config = readConfig()
  const providers = config.models?.providers || {}
  const nextProviders: Record<string, ProviderConfig> = { ...providers }
  const existingYutianProvider =
    nextProviders[YUTIAN_PROVIDER_KEY] ||
    YUTIAN_LEGACY_PROVIDER_KEYS.map((key) => nextProviders[key]).find(Boolean)

  for (const providerKey of YUTIAN_LEGACY_PROVIDER_KEYS) {
    delete nextProviders[providerKey]
  }
  nextProviders[YUTIAN_PROVIDER_KEY] = buildYutianProviderConfig(
    YUTIAN_PROVIDER_KEY,
    existingYutianProvider,
    apiInfo
  )

  const nextConfig: OpenclawConfig = {
    ...config,
    models: {
      ...(config.models || {}),
      providers: nextProviders,
    },
    agents: {
      ...(config.agents || {}),
      defaults: {
        ...(config.agents?.defaults || {}),
      },
    },
  }

  nextConfig.agents!.defaults!.model = {
    primary: `${YUTIAN_PROVIDER_KEY}/${apiInfo.modelId}`,
    fallbacks: [],
  }

  writeConfig(nextConfig, { source: 'provider', summary: '同步誉天账号默认模型密钥' })
  ensureYutianModelRouting()
}

export async function syncYutianApiKeyToProviders(): Promise<{ apiKeySynced: boolean }> {
  const apiInfo = await fetchYutianApiInfo({ allowConfiguredFallback: true })
  applyYutianApiKey(apiInfo)
  const store = loadStore()
  saveStore({
    user: store.user
      ? { ...store.user, ...apiInfo.userPatch }
      : (apiInfo.userPatch as YutianUserInfo),
    apiKeySyncedAt: new Date().toISOString(),
  })
  return { apiKeySynced: true }
}

interface RefreshYutianAccountOptions {
  syncApiInfo?: boolean
}

async function completeYutianLogin(
  body: JsonResponse,
  fallbackUser: Partial<YutianUserInfo>
): Promise<YutianAccountState> {
  const user = extractUser(body) || (fallbackUser as YutianUserInfo)
  saveStore({ accessToken: undefined, sessionAuthenticated: true, user })

  let message: string | undefined
  try {
    await refreshYutianAccountState({ syncApiInfo: false })
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
    log.warn('failed to refresh yutian user after login:', message)
  }

  try {
    await syncYutianApiKeyToProviders()
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
    log.warn('failed to sync yutian api key:', message)
  }

  return getYutianAccountState(message)
}

export async function sendYutianSms(payload: YutianSmsPayload): Promise<{ success: boolean }> {
  const phone = payload.phone.trim()
  if (!phone) throw new Error('请输入手机号')
  const params = new URLSearchParams({
    phone,
    purpose: 'p',
  })
  const body = await requestJson(`/api/verification/sms?${params.toString()}`)
  assertSuccess(body, '发送短信验证码失败')
  return { success: true }
}

export async function registerYutianAccount(
  payload: YutianRegisterPayload
): Promise<YutianAccountState> {
  const username = payload.username.trim()
  const password = payload.password.trim()
  const phone = payload.phone?.trim()
  const code = payload.code?.trim()
  const path = phone && code ? '/api/user/register/phone' : YUTIAN_REGISTER_PATH
  const body = await requestJson(path, {
    method: 'POST',
    body: { username, password, phone, code },
  })
  assertSuccess(body, '誉天账号注册失败')
  return loginYutianAccount({ username, password })
}

export async function loginYutianAccount(payload: YutianAuthPayload): Promise<YutianAccountState> {
  const username = payload.username.trim()
  const password = payload.password.trim()
  log.info('yutian password login request', {
    username,
    passwordLength: password.length,
    endpoint: YUTIAN_LOGIN_PATH,
  })
  const body = await requestJson(YUTIAN_LOGIN_PATH, {
    method: 'POST',
    body: { username, password },
  })
  if (body.success === false) {
    log.warn('yutian password login rejected', {
      username,
      passwordLength: password.length,
      message: body.message,
    })
  }
  assertSuccess(body, '誉天账号登录失败')
  return completeYutianLogin(body, { username })
}

export async function loginYutianPhone(
  payload: YutianPhoneAuthPayload
): Promise<YutianAccountState> {
  const phone = payload.phone.trim()
  const code = payload.code.trim()
  if (!phone || !code) throw new Error('请输入手机号和验证码')
  const body = await requestJson('/api/user/login/phone', {
    method: 'POST',
    body: { phone, code },
  })
  assertSuccess(body, '手机号验证码登录失败')
  return completeYutianLogin(body, { username: phone })
}

export async function logoutYutianAccount(): Promise<YutianAccountState> {
  try {
    await requestJson('/api/user/logout', { method: 'POST', accessAuth: true })
  } catch (err) {
    log.warn('remote logout failed:', err)
  }
  clearStore()
  try {
    await session.defaultSession.clearStorageData({
      origin: YUTIAN_API_BASE,
      storages: ['cookies'],
    })
  } catch (err) {
    log.warn('failed to clear yutian session cookie:', err)
  }
  return getYutianAccountState()
}

export async function refreshYutianAccountState(
  options: RefreshYutianAccountOptions = {}
): Promise<YutianAccountState> {
  const store = loadStore()
  if (!store.accessToken && !store.sessionAuthenticated && !store.sessionCookie) {
    return getYutianAccountState()
  }

  let body: JsonResponse
  try {
    body = await requestJson('/api/user/self', { accessAuth: true })
  } catch {
    try {
      body = await requestJson('/api/user/info', { accessAuth: true })
    } catch {
      body = await requestJson('/api/me', { accessAuth: true })
    }
  }
  assertSuccess(body, '刷新誉天账号信息失败')
  if (body.loggedIn === false) {
    clearStore()
    return getYutianAccountState()
  }
  const user = { ...(store.user || {}), ...(extractUser(body) || {}) }
  if (options.syncApiInfo !== false) {
    try {
      const apiInfo = await fetchYutianApiInfo({
        preferConfiguredKey: true,
        allowConfiguredFallback: true,
      })
      if (getConfiguredYutianApiKey() !== apiInfo.apiKey) {
        applyYutianApiKey(apiInfo)
      }
      Object.assign(user, apiInfo.userPatch)
    } catch (err) {
      log.debug('refresh yutian api-info skipped:', err)
    }
  }
  saveStore({ user })
  return getYutianAccountState()
}

export function getYutianAccountState(message?: string): YutianAccountState {
  const store = loadStore()
  const loggedIn = Boolean(
    (store.accessToken || store.sessionAuthenticated || store.sessionCookie) && store.user
  )
  return {
    loggedIn,
    user: loggedIn ? store.user || null : null,
    hasAccessToken: Boolean(store.accessToken || store.sessionAuthenticated || store.sessionCookie),
    hasApiKey: hasConfiguredYutianApiKey(),
    apiKeySyncedAt: store.apiKeySyncedAt,
    message,
  }
}
