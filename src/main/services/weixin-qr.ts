import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import JSON5 from 'json5'
import { OPENCLAW_HOME, CONFIG_PATH } from '../constants'
import { createLogger } from '../logger'

const log = createLogger('weixin-qr')

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
const DEFAULT_BOT_TYPE = '3'
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000
const QR_LONG_POLL_TIMEOUT_MS = 35_000
const MAX_QR_REFRESH_COUNT = 3
const POLL_INTERVAL_MS = 1_000

type ActiveLogin = {
  sessionKey: string
  qrcode: string
  qrcodeUrl: string
  startedAt: number
}

interface QRCodeResponse {
  qrcode?: string
  qrcode_img_content?: string
}

interface StatusResponse {
  status?: 'wait' | 'scaned' | 'confirmed' | 'expired'
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
}

export interface WeixinScanStartResult {
  qrDataUrl?: string
  message: string
  sessionKey: string
}

export interface WeixinScanWaitResult {
  connected: boolean
  message: string
  accountId?: string
}

const activeLogins = new Map<string, ActiveLogin>()

function normalizeAccountId(accountId: string): string {
  return accountId.trim().replace(/[^a-zA-Z0-9-_]+/g, '-')
}

function resolveWeixinDir(): string {
  return join(OPENCLAW_HOME, 'openclaw-weixin')
}

function resolveAccountsDir(): string {
  return join(resolveWeixinDir(), 'accounts')
}

function resolveAccountIndexPath(): string {
  return join(resolveWeixinDir(), 'accounts.json')
}

function resolveAccountPath(accountId: string): string {
  return join(resolveAccountsDir(), `${accountId}.json`)
}

function purgeExpiredLogins(): void {
  for (const [key, login] of activeLogins.entries()) {
    if (Date.now() - login.startedAt >= ACTIVE_LOGIN_TTL_MS) {
      activeLogins.delete(key)
    }
  }
}

function loadConfigRouteTag(accountId?: string): string | undefined {
  try {
    if (!existsSync(CONFIG_PATH)) return undefined
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    const cfg = JSON5.parse(raw) as {
      channels?: {
        'openclaw-weixin'?: {
          routeTag?: string | number
          accounts?: Record<string, { routeTag?: string | number }>
        }
      }
    }
    const section = cfg.channels?.['openclaw-weixin']
    if (!section) return undefined
    const accountRouteTag = accountId ? section.accounts?.[accountId]?.routeTag : undefined
    const routeTag = accountRouteTag ?? section.routeTag
    if (typeof routeTag === 'number') return String(routeTag)
    if (typeof routeTag === 'string' && routeTag.trim()) return routeTag.trim()
  } catch (err) {
    log.warn('loadConfigRouteTag failed:', err)
  }
  return undefined
}

async function fetchQrCode(
  apiBaseUrl: string,
  botType: string,
  accountId?: string
): Promise<Required<QRCodeResponse>> {
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base)
  const headers: Record<string, string> = {}
  const routeTag = loadConfigRouteTag(accountId)
  if (routeTag) headers.SKRouteTag = routeTag

  const response = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) {
    throw new Error(`获取二维码失败: HTTP ${response.status}`)
  }
  const data = (await response.json()) as QRCodeResponse
  if (!data.qrcode || !data.qrcode_img_content) {
    throw new Error('获取二维码失败，响应格式异常')
  }
  return { qrcode: data.qrcode, qrcode_img_content: data.qrcode_img_content }
}

async function pollQrStatus(
  apiBaseUrl: string,
  qrcode: string,
  accountId?: string
): Promise<StatusResponse> {
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base)
  const headers: Record<string, string> = {
    'iLink-App-ClientVersion': '1',
  }
  const routeTag = loadConfigRouteTag(accountId)
  if (routeTag) headers.SKRouteTag = routeTag

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS)
  try {
    const response = await fetch(url.toString(), { headers, signal: controller.signal })
    if (!response.ok) {
      throw new Error(`查询扫码状态失败: HTTP ${response.status}`)
    }
    return (await response.json()) as StatusResponse
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait' }
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function listIndexedAccounts(): string[] {
  try {
    if (!existsSync(resolveAccountIndexPath())) return []
    const parsed = JSON.parse(readFileSync(resolveAccountIndexPath(), 'utf-8'))
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function registerAccountId(accountId: string): void {
  mkdirSync(resolveWeixinDir(), { recursive: true })
  const ids = listIndexedAccounts()
  if (ids.includes(accountId)) return
  writeFileSync(resolveAccountIndexPath(), JSON.stringify([...ids, accountId], null, 2), 'utf-8')
}

function unregisterAccountId(accountId: string): void {
  const ids = listIndexedAccounts().filter((id) => id !== accountId)
  mkdirSync(resolveWeixinDir(), { recursive: true })
  writeFileSync(resolveAccountIndexPath(), JSON.stringify(ids, null, 2), 'utf-8')
}

function saveWeixinAccount(
  accountId: string,
  data: { token?: string; baseUrl?: string; userId?: string }
): void {
  mkdirSync(resolveAccountsDir(), { recursive: true })
  const filePath = resolveAccountPath(accountId)
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        ...(data.token ? { token: data.token, savedAt: new Date().toISOString() } : {}),
        ...(data.baseUrl ? { baseUrl: data.baseUrl } : {}),
        ...(data.userId ? { userId: data.userId } : {}),
      },
      null,
      2
    ),
    'utf-8'
  )
}

export async function startWeixinQrScan(params?: {
  accountId?: string
  force?: boolean
  timeoutMs?: number
}): Promise<WeixinScanStartResult> {
  const sessionKey = params?.accountId?.trim() || randomUUID()
  purgeExpiredLogins()

  const existing = activeLogins.get(sessionKey)
  if (existing && !params?.force && Date.now() - existing.startedAt < ACTIVE_LOGIN_TTL_MS) {
    return {
      qrDataUrl: existing.qrcodeUrl,
      message: '二维码已就绪，请使用微信扫描。',
      sessionKey,
    }
  }

  const qr = await fetchQrCode(DEFAULT_BASE_URL, DEFAULT_BOT_TYPE, params?.accountId)
  activeLogins.set(sessionKey, {
    sessionKey,
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcode_img_content,
    startedAt: Date.now(),
  })

  return {
    qrDataUrl: qr.qrcode_img_content,
    message: '使用微信扫描以下二维码，以完成连接。',
    sessionKey,
  }
}

export async function waitWeixinQrScan(params: {
  sessionKey?: string
  accountId?: string
  timeoutMs?: number
}): Promise<WeixinScanWaitResult> {
  const sessionKey = params.sessionKey?.trim() || params.accountId?.trim() || ''
  let active = activeLogins.get(sessionKey)
  if (!active) {
    throw new Error('当前没有进行中的微信登录，请先获取二维码')
  }

  const deadline = Date.now() + Math.max(params.timeoutMs ?? 120_000, 1_000)
  let refreshCount = 1

  while (Date.now() < deadline) {
    active = activeLogins.get(sessionKey)
    if (!active) {
      return {
        connected: false,
        message: '微信扫码已取消',
      }
    }

    const status = await pollQrStatus(DEFAULT_BASE_URL, active.qrcode, params.accountId)

    active = activeLogins.get(sessionKey)
    if (!active) {
      return {
        connected: false,
        message: '微信扫码已取消',
      }
    }

    if (status.status === 'confirmed') {
      if (!status.ilink_bot_id || !status.bot_token) {
        activeLogins.delete(sessionKey)
        throw new Error('扫码成功，但未返回 bot 账号信息')
      }
      const normalizedId = normalizeAccountId(status.ilink_bot_id)
      saveWeixinAccount(normalizedId, {
        token: status.bot_token,
        baseUrl: status.baseurl || DEFAULT_BASE_URL,
        userId: status.ilink_user_id,
      })
      registerAccountId(normalizedId)
      activeLogins.delete(sessionKey)
      return {
        connected: true,
        message: '与微信连接成功',
        accountId: normalizedId,
      }
    }

    if (status.status === 'expired') {
      refreshCount += 1
      if (refreshCount > MAX_QR_REFRESH_COUNT) {
        activeLogins.delete(sessionKey)
        throw new Error('二维码已多次过期，请重新开始登录')
      }
      const qr = await fetchQrCode(DEFAULT_BASE_URL, DEFAULT_BOT_TYPE, params.accountId)
      active.qrcode = qr.qrcode
      active.qrcodeUrl = qr.qrcode_img_content
      active.startedAt = Date.now()
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  activeLogins.delete(sessionKey)
  throw new Error('微信扫码超时，请重试')
}

export function logoutWeixinAccount(accountId: string): void {
  const trimmed = accountId.trim()
  if (!trimmed) throw new Error('缺少微信账户 ID')
  try {
    unlinkSync(resolveAccountPath(trimmed))
  } catch {
    // ignore missing local account file
  }
  unregisterAccountId(trimmed)
}

export function cancelWeixinQrScan(sessionKey?: string): void {
  const key = sessionKey?.trim()
  if (!key) return
  activeLogins.delete(key)
}

export function cancelAllWeixinQrScans(): void {
  activeLogins.clear()
}
