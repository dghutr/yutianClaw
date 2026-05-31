/**
 * useGatewayWs — OpenClaw Gateway WebSocket 客户端 Hook
 *
 * 协议（Ed25519 设备签名模式）：
 * 1. 连接 ws://127.0.0.1:<port>/ws?token=<token>
 * 2. Gateway 发 connect.challenge（带 nonce）
 * 3. 客户端用私钥对 payload 签名，发送 connect req（含 device 签名 + auth.token）
 * 4. 握手成功 → 存储 Gateway 颁发的 deviceToken，下次复用
 * 5. 从 snapshot.sessionDefaults.mainSessionKey 获取 sessionKey
 * 6. 开始正常通信（chat.send / chat.history / chat.abort）
 *
 * 错误自动修复：
 * - TOKEN_MISMATCH  → 清除本地 deviceToken，用 gatewayToken 重签（最多 1 次）
 * - NOT_PAIRED / origin not allowed → 自动写入 allowedOrigins，重启后重连（最多 1 次）
 *
 * 流式事件：
 * - delta: message.content 为累积全文（直接替换，非增量追加）
 * - final: 最终内容 + usage + durationMs
 * - aborted: 用户中止
 * - error: 错误信息
 */

import { useEffect, useRef, useCallback, useState } from 'react'

// ========== 类型定义 ==========

export type WsStatus = 'disconnected' | 'connecting' | 'handshaking' | 'ready' | 'error'

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface ChatToolCall {
  id: string
  name: string
  argumentsText?: string
  resultText?: string
  status: 'loading' | 'success' | 'error'
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** Local/render timestamp used to protect optimistic messages during silent history refreshes. */
  timestamp?: number
  /** 思考内容（assistant） */
  thinking?: string
  /** 工具调用链（assistant） */
  toolCalls?: ChatToolCall[]
  /** 流式状态（仅 assistant 消息有效） */
  streaming?: boolean
  /** token 消耗 */
  usage?: ChatUsage
  /** 耗时 ms */
  durationMs?: number
  /** 当前回答模型 */
  model?: string
  /** 当前回答提供方 */
  provider?: string
  /** 附件（用户消息） */
  attachments?: AttachmentPayload[]
}

/** 发送消息时的附件载荷 */
export interface AttachmentPayload {
  category: 'image' | 'document' | 'video' | 'audio'
  mimeType: string
  fileName: string
  content: string // base64
  /** 本地生成文件路径。用于 assistant 生成 PDF/文档后在窗口里直接打开。 */
  localPath?: string
}

/** 会话列表项 */
export interface SessionItem {
  key: string
  label: string
  updatedAt?: number
}

interface RawSessionListItem {
  sessionKey?: string
  key?: string
  updatedAt?: number
  lastActivity?: number
  displayName?: string
  derivedTitle?: string
  label?: string
  origin?: {
    label?: string
    displayName?: string
    conversationLabel?: string
    senderName?: string
    from?: string
    to?: string
    provider?: string
    surface?: string
  }
  deliveryContext?: {
    channel?: string
    to?: string
    accountId?: string
    label?: string
  }
}

interface FeishuPeerTarget {
  key: string
  kind: 'user' | 'chat'
  id: string
}

interface FeishuPeerResolution {
  id: string
  kind: 'user' | 'chat'
  displayName?: string
  error?: string
}

interface FeishuSenderPrefix {
  id: string
  body: string
}

interface DraftSessionState {
  name: string
  agentId: string
  createdAt: number
}

export interface ChatEventPayload {
  state: 'delta' | 'final' | 'aborted' | 'error'
  sessionKey: string
  runId: string
  message?: { content: string | ContentBlock[]; model?: string; provider?: string }
  usage?: unknown
  durationMs?: number
  model?: string
  provider?: string
  errorMessage?: string
  error?: { message: string; code?: string }
}

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  reasoning?: string
  reasoningContent?: string
  reasoning_content?: string
  id?: string
  name?: string
  arguments?: unknown
  toolCallId?: string
  content?: unknown
  isError?: boolean
}

interface WsFrame {
  type: 'req' | 'res' | 'event'
  id?: string
  ok?: boolean
  method?: string
  params?: unknown
  payload?: unknown
  error?: { message: string; code?: string }
  event?: string
}

interface RealtimeMessagePayload {
  id?: string
  role?: string
  content?: string | ContentBlock[]
  sessionKey?: string
  toolCallId?: string
  toolName?: string
  stopReason?: string
  isError?: boolean
  usage?: unknown
  durationMs?: number
  model?: string
  provider?: string
}

interface AgentToolEventPayload {
  runId?: string
  sessionKey?: string
  stream?: string
  data?: {
    toolCallId?: string
    name?: string
    phase?: string
    args?: unknown
    partialResult?: unknown
    result?: unknown
  }
}

interface HealthEventAgentPayload {
  agentId?: string
  id?: string
  sessions?: {
    recent?: unknown[]
  }
}

interface HealthEventPayload {
  sessions?: {
    recent?: unknown[]
  }
  agents?: unknown[]
}

// ========== 常量 ==========

const CHALLENGE_TIMEOUT_MS = 5000
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000]
const PING_INTERVAL_MS = 25000
const MIN_SESSION_REFRESH_GAP_MS = 15000
const MIN_SILENT_HISTORY_REFRESH_GAP_MS = 20000
const CHAT_HISTORY_LIMIT = 1000
const ACCOUNT_REFRESH_REQUEST_EVENT = 'yutianclaw:account-refresh-request'
const DEBUG_LOG_MAX_LEN = 30_000
const QUICK_TEXT_MAX_CHARS = 240
const QUICK_TEXT_SYSTEM_PROMPT =
  '你是小誉，YuTianClaw 教育行业 AI 数字员工。请始终优先使用简体中文，回答要自然、简洁、直接。'
const QUICK_TEXT_TASK_RE =
  /(生成|制作|创建|保存|写入|打开|发送|上传|下载|导出|打印|安装|运行|执行|修改|删除|搜索|查询文件|读取文件|截图|网页|浏览器|飞书|微信|企业微信|PDF|pdf|PPT|ppt|Excel|excel|Word|word|文件|图片|视频|音频|语音|表格|代码|命令|脚本|MCP|mcp|skill|工具|定时|任务|分析图片|解析图片|看图|识图|create|make|generate|save|write|open|send|upload|download|export|file|image|video|audio|browser|pdf|ppt|command|script|tool|mcp)/i
const LAST_SESSION_STORAGE_KEY = 'yutianclaw:last-session-key'

let _reqSeq = 0

interface GatewayRefreshThrottleState {
  sessionsInFlight: boolean
  lastSessionsRefreshAt: number
  historyInFlight: Set<string>
  lastSilentHistoryRefreshAt: Map<string, number>
}

function getGatewayRefreshThrottleState(): GatewayRefreshThrottleState {
  const root = window as typeof window & {
    __yutianclawGatewayRefreshThrottle?: GatewayRefreshThrottleState
  }
  if (!root.__yutianclawGatewayRefreshThrottle) {
    root.__yutianclawGatewayRefreshThrottle = {
      sessionsInFlight: false,
      lastSessionsRefreshAt: 0,
      historyInFlight: new Set<string>(),
      lastSilentHistoryRefreshAt: new Map<string, number>(),
    }
  }
  return root.__yutianclawGatewayRefreshThrottle
}

function requestAccountRefresh(): void {
  window.dispatchEvent(new CustomEvent(ACCOUNT_REFRESH_REQUEST_EVENT))
}

function shouldUseQuickTextRun(text: string, attachments?: AttachmentPayload[]): boolean {
  if (attachments?.length) return false
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > QUICK_TEXT_MAX_CHARS) return false
  if (trimmed.includes('\n\n') || trimmed.includes('```')) return false
  return !QUICK_TEXT_TASK_RE.test(trimmed)
}

function normalizeChatErrorText(input: unknown): string {
  const text = typeof input === 'string' ? input.trim() : ''
  if (!text) return '未知错误'
  if (/llm request timed out|request timed out|timed out/i.test(text)) {
    return '模型请求超时：当前任务较长或模型服务响应较慢，请稍后重试。若任务包含大量文件、PDF 或视频生成，建议拆成多个步骤执行。'
  }
  if (/http\s*524/i.test(text)) {
    return '模型服务暂时不可用（HTTP 524）：上游服务响应超时，请稍后重试。'
  }
  const httpMatch = text.match(/http\s*(\d{3})\s*[:：]?\s*(.*)$/i)
  if (httpMatch) {
    const status = httpMatch[1]
    const detail = httpMatch[2]?.trim()
    if (status === '401' || status === '403') {
      const reason = status === '401' ? '模型服务认证失败' : '模型服务拒绝了请求'
      const rawDetail = detail && !/^openai\s+error$/i.test(detail) ? `服务商返回：${detail}。` : ''
      return `${reason}（HTTP ${status}）。${rawDetail}常见原因：API Key 填错或已失效、账号/模型没有权限、余额不足、IP 白名单限制，或 Base URL/模型名称与该服务商不匹配。请检查当前选择的模型配置后重试。`
    }
    if (status === '429') {
      return `模型服务限流（HTTP 429）：请求过于频繁或额度不足。${detail ? `服务商返回：${detail}` : '请稍后重试或检查额度。'}`
    }
    if (/^5\d\d$/.test(status)) {
      return `模型服务异常（HTTP ${status}）：上游服务暂时不可用。${detail ? `服务商返回：${detail}` : '请稍后重试。'}`
    }
  }
  if (/openai error/i.test(text)) {
    return `模型服务返回 OpenAI 兼容接口错误：${text}。请检查 API Key、Base URL、模型名称、账号权限和余额。`
  }
  return text
}

function nextId(prefix = 'req'): string {
  return `${prefix}-${++_reqSeq}-${Math.random().toString(36).slice(2, 7)}`
}

/** 从 content（string 或 ContentBlock[]）提取纯文本 */
function messageComparableText(message: ChatMessage): string {
  return (message.content || '').trim().replace(/\s+/g, ' ')
}

function attachmentComparableKey(attachments: AttachmentPayload[] | undefined): string {
  if (!attachments?.length) return ''
  return attachments
    .map((attachment) =>
      [
        attachment.category,
        attachment.mimeType,
        attachment.fileName,
        attachment.localPath || '',
        attachment.content ? attachment.content.length : 0,
      ].join(':')
    )
    .sort()
    .join('|')
}

function messagesLookEquivalent(a: ChatMessage, b: ChatMessage): boolean {
  if (a.role !== b.role) return false
  if (messageComparableText(a) !== messageComparableText(b)) return false
  if (attachmentComparableKey(a.attachments) !== attachmentComparableKey(b.attachments)) {
    return false
  }
  const aTime = typeof a.timestamp === 'number' ? a.timestamp : undefined
  const bTime = typeof b.timestamp === 'number' ? b.timestamp : undefined
  if (aTime !== undefined && bTime !== undefined) {
    return Math.abs(aTime - bTime) < 120_000 || bTime >= aTime - 10_000
  }
  return true
}

function findLastStreamingAssistantIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant' && message.streaming) return index
  }
  return -1
}

function historyTimestampFromValue(value: unknown): number | undefined {
  const numeric = toNumber(value)
  if (numeric !== undefined) return numeric
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function getRawHistoryTimestamp(entry: unknown): number | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined
  const record = entry as Record<string, unknown>
  return historyTimestampFromValue(
    record.timestamp ??
      record.createdAt ??
      record.created_at ??
      record.updatedAt ??
      record.updated_at ??
      record.time ??
      record.ts
  )
}

function sortRawHistoryMessages(rawMessages: unknown[]): unknown[] {
  const decorated = rawMessages.map((entry, index) => ({
    entry,
    index,
    timestamp: getRawHistoryTimestamp(entry),
  }))
  if (!decorated.some((item) => item.timestamp !== undefined)) return rawMessages

  return decorated
    .sort((a, b) => {
      if (a.timestamp !== undefined && b.timestamp !== undefined && a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp
      }
      return a.index - b.index
    })
    .map((item) => item.entry)
}

function mergeLoadedHistoryWithLocalTail(
  loaded: ChatMessage[],
  current: ChatMessage[] | undefined
): ChatMessage[] {
  if (!current?.length) return loaded

  const loadedIds = new Set(loaded.map((message) => message.id).filter(Boolean))
  let lastConfirmedCurrentIndex = -1
  for (let index = 0; index < current.length; index += 1) {
    if (loadedIds.has(current[index].id)) {
      lastConfirmedCurrentIndex = index
    }
  }

  const localTail = current.slice(lastConfirmedCurrentIndex + 1)
  if (localTail.length === 0) return loaded

  const preserved: ChatMessage[] = []
  for (const message of localTail) {
    if (loadedIds.has(message.id)) continue
    if (loaded.some((loadedMessage) => messagesLookEquivalent(message, loadedMessage))) continue
    if (preserved.some((preservedMessage) => messagesLookEquivalent(message, preservedMessage))) {
      continue
    }
    preserved.push(message)
  }

  return preserved.length > 0 ? [...loaded, ...preserved] : loaded
}

function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('')
}

function extractToolResultText(content: unknown): string | undefined {
  if (!content) return undefined
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((item) => {
      const block = item as ContentBlock
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
  return text || undefined
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function normalizeUsage(usage: unknown): ChatUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const data = usage as Record<string, unknown>
  const inputTokens = toNumber(data.input_tokens ?? data.input) ?? 0
  const outputTokens = toNumber(data.output_tokens ?? data.output) ?? 0
  const totalTokens =
    toNumber(data.total_tokens ?? data.totalTokens ?? data.total) ?? inputTokens + outputTokens
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return undefined
  return { inputTokens, outputTokens, totalTokens }
}

function pickText(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function fileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath
}

function normalizeMediaDirectivePath(rawPath: string): string {
  let value = rawPath.trim().replace(/^["'`]|["'`]$/g, '')
  if (/^file:\/\//i.test(value)) {
    try {
      const parsed = new URL(value)
      value = decodeURIComponent(parsed.pathname || value)
      if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1)
      value = value.replace(/\//g, '\\')
    } catch {
      // Keep the original value when URL parsing fails.
    }
  }
  return value
}

function mimeTypeFromFileName(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.doc')) return 'application/msword'
  if (lower.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel'
  if (lower.endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }
  if (lower.endsWith('.ppt')) return 'application/vnd.ms-powerpoint'
  if (lower.endsWith('.pptx')) {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }
  if (lower.endsWith('.txt')) return 'text/plain'
  if (lower.endsWith('.md')) return 'text/markdown'
  if (/\.(png|jpg|jpeg|gif|webp)$/i.test(lower)) return `image/${lower.split('.').pop()}`
  if (lower.endsWith('.mp4')) return 'video/mp4'
  if (lower.endsWith('.mov')) return 'video/quicktime'
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.m4v')) return 'video/x-m4v'
  if (lower.endsWith('.avi')) return 'video/x-msvideo'
  if (lower.endsWith('.mkv')) return 'video/x-matroska'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.m4a')) return 'audio/mp4'
  if (lower.endsWith('.aac')) return 'audio/aac'
  if (lower.endsWith('.ogg')) return 'audio/ogg'
  if (lower.endsWith('.flac')) return 'audio/flac'
  return 'application/octet-stream'
}

function categoryFromMimeType(mimeType: string): AttachmentPayload['category'] {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return 'document'
}

function extractMediaDirectiveAttachments(text: string): {
  text: string
  attachments: AttachmentPayload[]
} {
  if (!text.includes('MEDIA:')) return { text, attachments: [] }

  const attachments: AttachmentPayload[] = []
  const keptLines: string[] = []

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*MEDIA:\s*(.+?)\s*$/i)
    if (!match) {
      keptLines.push(line)
      continue
    }

    const localPath = normalizeMediaDirectivePath(match[1])
    if (!localPath) continue
    const fileName = fileNameFromPath(localPath)
    const mimeType = mimeTypeFromFileName(fileName)
    attachments.push({
      category: categoryFromMimeType(mimeType),
      mimeType,
      fileName,
      content: '',
      localPath,
    })
  }

  return { text: keptLines.join('\n').trimEnd(), attachments }
}

const LOCAL_ATTACHMENT_PATH_RE =
  /\b[A-Za-z]:(?:\\+[^\\/:*?"<>|\r\n]+)+\.(?:pdf|docx?|xlsx?|pptx?|txt|md|png|jpe?g|gif|webp|mp4|mov|webm|m4v|avi|mkv|mp3|wav|m4a|aac|ogg|flac)\b/gi

function normalizeInferredLocalPath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/\\{2,}/g, '\\')
    .replace(/[),.;]+$/g, '')
}

function extractLocalFileAttachmentsFromText(text: string): AttachmentPayload[] {
  if (!text) return []
  const matches = text.match(LOCAL_ATTACHMENT_PATH_RE)
  if (!matches?.length) return []

  const attachments: AttachmentPayload[] = []
  const seen = new Set<string>()

  for (const raw of matches) {
    const localPath = normalizeInferredLocalPath(raw)
    if (!localPath || seen.has(localPath)) continue
    seen.add(localPath)
    const fileName = fileNameFromPath(localPath)
    const mimeType = mimeTypeFromFileName(fileName)
    attachments.push({
      category: categoryFromMimeType(mimeType),
      mimeType,
      fileName,
      content: '',
      localPath,
    })
  }

  return attachments
}

function mergeAttachments(
  base: AttachmentPayload[] | undefined,
  incoming: AttachmentPayload[] | undefined
): AttachmentPayload[] | undefined {
  if (!base?.length && !incoming?.length) return undefined
  const next: AttachmentPayload[] = []
  const seen = new Set<string>()

  for (const attachment of [...(base || []), ...(incoming || [])]) {
    const key =
      attachment.localPath ||
      `${attachment.fileName}:${attachment.mimeType}:${attachment.content.slice(0, 32)}`
    if (seen.has(key)) continue
    seen.add(key)
    next.push(attachment)
  }

  return next
}

function isOpaqueFeishuId(value: string): boolean {
  return /^(ou_|on_|oc_|chat_)/i.test(value.trim())
}

function isReadableSessionLabel(value: unknown, key: string): value is string {
  if (typeof value !== 'string') return false
  const label = value.trim()
  if (!label || label === key || isOpaqueFeishuId(label)) return false
  if (/^feishu:(direct|dm|user|group|chat|channel):/i.test(label)) return false
  return true
}

function formatFeishuFallback(kind: 'user' | 'chat'): string {
  return kind === 'user' ? '飞书私聊' : '飞书群聊'
}

function formatFeishuPeerLabel(kind: 'user' | 'chat', displayName?: string): string {
  const name = displayName?.trim()
  if (!name) return formatFeishuFallback(kind)
  return kind === 'user' ? `飞书 · ${name}` : `飞书群 · ${name}`
}

function feishuPeerCacheKey(kind: 'user' | 'chat', id: string): string {
  return `${kind}:${id.trim()}`
}

function parseFeishuSenderPrefix(text: string): FeishuSenderPrefix | null {
  const withoutMessageId = text.replace(/^\s*\[message_id:\s*[^\]]+\]\s*\n+/i, '')
  const match = withoutMessageId.match(/^\s*((?:ou|on)_[A-Za-z0-9_-]+)\s*[:：]\s*([\s\S]*)$/)
  if (!match) return null
  return { id: match[1].trim(), body: match[2] ?? '' }
}

function collectFeishuSenderTargets(rawMessages: unknown[]): FeishuPeerTarget[] {
  const targets: FeishuPeerTarget[] = []
  for (const entry of rawMessages) {
    const msg = entry as { role?: string; content?: string | ContentBlock[] }
    if (msg.role !== 'user') continue
    const text = extractText(msg.content)
    const parsed = parseFeishuSenderPrefix(text)
    if (parsed) targets.push({ key: parsed.id, kind: 'user', id: parsed.id })
  }
  return targets
}

function formatFeishuIncomingUserText(text: string, peerNames: Map<string, string>): string {
  const parsed = parseFeishuSenderPrefix(text)
  if (!parsed) return text
  const name = peerNames.get(feishuPeerCacheKey('user', parsed.id)) || '飞书用户'
  return `${name}：${parsed.body}`
}

function parseFeishuChannelTarget(channel: string, key: string): FeishuPeerTarget | null {
  const parts = channel.split(':')
  if (parts[0] !== 'feishu' || parts.length < 3) return null
  const scope = parts[1]
  const id = parts.slice(2).join(':').trim()
  if (!id) return null
  const kind = ['direct', 'dm', 'user', 'open_id'].includes(scope) ? 'user' : 'chat'
  return { key, kind, id }
}

function parseFeishuRouteTarget(value: unknown, key: string): FeishuPeerTarget | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const match = trimmed.match(/^(user|dm|open_id|chat|group|channel):(.+)$/i)
  if (!match) return null
  const id = match[2]?.trim()
  if (!id) return null
  const kind = ['user', 'dm', 'open_id'].includes(match[1].toLowerCase()) ? 'user' : 'chat'
  return { key, kind, id }
}

function getFeishuTargetFromSession(
  key: string,
  session?: RawSessionListItem
): FeishuPeerTarget | null {
  return (
    parseFeishuRouteTarget(session?.deliveryContext?.to, key) ||
    parseFeishuRouteTarget(session?.origin?.to, key) ||
    parseFeishuChannelTarget(key.split(':').slice(2).join(':'), key)
  )
}

function formatSessionChannelLabel(channel: string): string {
  const target = parseFeishuChannelTarget(channel, '')
  if (target) return formatFeishuFallback(target.kind)
  return channel
}

function formatSessionTitleTime(timestamp: number): string {
  const date = new Date(timestamp || Date.now())
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  return `${hour}${minute}${second}`
}

function buildSessionTitleFromMessage(message: string, timestamp = Date.now()): string {
  const cleaned = message
    .replace(/[\u0000-\u001f\\/?*"<>|:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const prefix = Array.from(cleaned).slice(0, 5).join('').trim() || '新会话'
  return `${prefix} ${formatSessionTitleTime(timestamp)}`
}

function sortSessionsByActivity(items: SessionItem[], previousOrder: SessionItem[] = []): SessionItem[] {
  const order = new Map(previousOrder.map((item, index) => [item.key, index]))
  return [...items].sort((a, b) => {
    const diff = (b.updatedAt || 0) - (a.updatedAt || 0)
    if (diff !== 0) return diff
    const aIndex = order.get(a.key) ?? Number.MAX_SAFE_INTEGER
    const bIndex = order.get(b.key) ?? Number.MAX_SAFE_INTEGER
    if (aIndex !== bIndex) return aIndex - bIndex
    return a.key.localeCompare(b.key)
  })
}

function pickProvidedSessionLabel(session: RawSessionListItem, key: string): string | undefined {
  const candidates = [
    session.displayName,
    session.derivedTitle,
    session.label,
    session.origin?.conversationLabel,
    session.origin?.displayName,
    session.origin?.senderName,
    session.origin?.label,
    session.deliveryContext?.label,
  ]
  return candidates.find((value) => isReadableSessionLabel(value, key))?.trim()
}

function toSessionItem(session: RawSessionListItem): SessionItem | null {
  const key = session.sessionKey || session.key || ''
  if (!key) return null
  return {
    key,
    label: pickProvidedSessionLabel(session, key) || parseSessionLabel(key),
    updatedAt: toNumber(session.updatedAt ?? session.lastActivity),
  }
}

function mergeSessionItems(current: SessionItem[], incoming: SessionItem[]): SessionItem[] {
  if (incoming.length === 0) return current

  const byKey = new Map(current.map((item) => [item.key, item]))
  for (const item of incoming) {
    const existing = byKey.get(item.key)
    const existingUpdatedAt = existing?.updatedAt ?? 0
    const incomingUpdatedAt = item.updatedAt ?? existingUpdatedAt
    const nextUpdatedAt = Math.max(existingUpdatedAt, incomingUpdatedAt)
    const label =
      existing?.label && existing.label !== existing.key && !isOpaqueFeishuId(existing.label)
        ? existing.label
        : item.label
    byKey.set(item.key, {
      ...existing,
      ...item,
      label,
      updatedAt: nextUpdatedAt || undefined,
    })
  }

  return sortSessionsByActivity(Array.from(byKey.values()), current)
}

function collectHealthSessionItems(payload: unknown): SessionItem[] {
  if (!payload || typeof payload !== 'object') return []
  const data = payload as HealthEventPayload
  const items: SessionItem[] = []
  const seen = new Set<string>()

  const collectRecent = (recent: unknown): void => {
    if (!Array.isArray(recent)) return
    for (const entry of recent) {
      if (!entry || typeof entry !== 'object') continue
      const item = toSessionItem(entry as RawSessionListItem)
      if (!item || seen.has(item.key)) continue
      seen.add(item.key)
      items.push(item)
    }
  }

  collectRecent(data.sessions?.recent)
  if (Array.isArray(data.agents)) {
    for (const rawAgent of data.agents) {
      if (!rawAgent || typeof rawAgent !== 'object') continue
      collectRecent((rawAgent as HealthEventAgentPayload).sessions?.recent)
    }
  }

  return items
}

function toJsonText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function stringifyForDebugLog(value: unknown, maxLen = DEBUG_LOG_MAX_LEN): string {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === 'bigint') return String(val)
      if (typeof val === 'function') return '[Function]'
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[Circular]'
        seen.add(val)
      }
      return val
    },
    2
  )
  if (!json) return ''
  if (json.length <= maxLen) return json
  return `${json.slice(0, maxLen)}...<truncated ${json.length - maxLen} chars>`
}

function normalizeAssistantContent(content: string | ContentBlock[] | undefined): {
  text: string
  thinking?: string
  toolCalls?: ChatToolCall[]
  attachments?: AttachmentPayload[]
} {
  if (!content) return { text: '' }
  if (typeof content === 'string') {
    const media = extractMediaDirectiveAttachments(content)
    return {
      text: media.text,
      attachments: mergeAttachments(
        media.attachments,
        extractLocalFileAttachmentsFromText(media.text)
      ),
    }
  }

  const textParts: string[] = []
  const thinkingParts: string[] = []
  const toolCalls: ChatToolCall[] = []

  for (const block of content) {
    const blockThinking = pickText(
      block.thinking,
      block.reasoning,
      block.reasoningContent,
      block.reasoning_content
    )
    if (
      blockThinking &&
      (block.type === 'thinking' ||
        block.type === 'reasoning' ||
        block.type === 'reasoning_content' ||
        block.type === 'thinking_delta')
    ) {
      thinkingParts.push(blockThinking)
      continue
    }
    if (block.type === 'text' && block.text) {
      textParts.push(block.text)
      continue
    }
    if (block.type === 'thinking' && block.thinking) {
      thinkingParts.push(block.thinking)
      continue
    }
    if (block.type === 'toolCall') {
      const id = pickText(block.id) || nextId('tool')
      const name = pickText(block.name) || 'tool'
      toolCalls.push({
        id,
        name,
        argumentsText: toJsonText(block.arguments),
        status: 'loading',
      })
      continue
    }
    if (block.type === 'toolResult') {
      const targetId = pickText(block.toolCallId, block.id)
      if (!targetId) continue
      const idx = toolCalls.findIndex((t) => t.id === targetId)
      if (idx < 0) continue
      toolCalls[idx] = {
        ...toolCalls[idx],
        resultText: extractToolResultText(block.content),
        status: block.isError ? 'error' : 'success',
      }
    }
  }

  const media = extractMediaDirectiveAttachments(textParts.join(''))
  const inferredAttachmentText = [
    media.text,
    ...toolCalls.map((tool) => [tool.argumentsText, tool.resultText].filter(Boolean).join('\n')),
  ].join('\n')
  return {
    text: media.text,
    thinking: thinkingParts.length > 0 ? thinkingParts.join('\n\n') : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    attachments: mergeAttachments(
      media.attachments,
      extractLocalFileAttachmentsFromText(inferredAttachmentText)
    ),
  }
}

function mergeThinkingText(
  existing: string | undefined,
  incoming: string | undefined
): string | undefined {
  const next = incoming?.trim()
  if (!next) return existing
  const prev = existing?.trim()
  if (!prev) return next
  if (prev.includes(next)) return prev
  if (next.includes(prev)) return next
  return `${prev}\n\n${next}`
}

function mergeToolCalls(
  base: ChatToolCall[] | undefined,
  incoming: ChatToolCall[] | undefined
): ChatToolCall[] | undefined {
  if (!base?.length) return incoming
  if (!incoming?.length) return base
  const next = [...base]
  for (const tool of incoming) {
    const idx = next.findIndex((item) => item.id === tool.id)
    if (idx < 0) {
      next.push(tool)
      continue
    }
    next[idx] = {
      ...next[idx],
      ...tool,
      argumentsText: tool.argumentsText ?? next[idx].argumentsText,
      resultText: tool.resultText ?? next[idx].resultText,
    }
  }
  return next
}

function getTerminalFailureReason(content: string): string | undefined {
  const text = content.trim()
  if (!text) return undefined
  const lower = text.toLowerCase()
  if (lower.includes('session file locked')) {
    return 'Run failed: session file was locked.'
  }
  if (
    lower.includes('agent failed before reply') ||
    lower.includes('assistant turn failed before producing content')
  ) {
    return 'Run failed before a reply was produced.'
  }
  if (lower.includes('operation was aborted') || lower.includes('aborted')) {
    return 'Run was aborted before this step finished.'
  }
  return undefined
}

function closeDanglingToolCallsBeforeFailures(messages: ChatMessage[]): ChatMessage[] {
  let next = messages

  const closeBefore = (endIndex: number, reason: string): void => {
    let touched = false
    const updated = next.map((message, index) => {
      if (index >= endIndex || message.role !== 'assistant' || !message.toolCalls?.length) {
        return message
      }
      let changed = false
      const toolCalls = message.toolCalls.map((toolCall) => {
        if (toolCall.status !== 'loading') return toolCall
        changed = true
        return {
          ...toolCall,
          status: 'error' as const,
          resultText: toolCall.resultText || reason,
        }
      })
      if (!changed) return message
      touched = true
      return { ...message, toolCalls, streaming: false }
    })
    if (touched) next = updated
  }

  next.forEach((message, index) => {
    if (message.role !== 'assistant') return
    const reason = getTerminalFailureReason(message.content)
    if (reason) closeBefore(index, reason)
  })

  return next
}

/** 从 sessionKey 解析显示名称（格式：agent:<agentId>:<channelName>） */
export function parseSessionLabel(key: string): string {
  const parts = (key || '').split(':')
  if (parts.length < 3) return key || '未知'
  const agent = parts[1] || 'main'
  const channel = parts.slice(2).join(':')
  if (agent === 'main' && channel === 'main') return '主会话'
  const channelLabel = formatSessionChannelLabel(channel)
  if (agent === 'main') return channelLabel
  return `${agent} / ${channelLabel}`
}

function isDraftSessionKey(key?: string | null): boolean {
  return Boolean(key && key.startsWith('draft:'))
}

function readLastSessionKey(): string | null {
  try {
    const key = window.localStorage.getItem(LAST_SESSION_STORAGE_KEY)?.trim() || ''
    if (!key || isDraftSessionKey(key)) return null
    return key
  } catch {
    return null
  }
}

function rememberSessionKey(key?: string | null): void {
  if (!key || isDraftSessionKey(key)) return
  try {
    window.localStorage.setItem(LAST_SESSION_STORAGE_KEY, key)
  } catch {
    // localStorage may be unavailable in rare renderer recovery states.
  }
}

function parseAgentIdFromSessionKey(key?: string | null): string | undefined {
  if (!key) return undefined
  const parts = key.split(':')
  if (parts.length < 2) return undefined
  return parts[1] || undefined
}

function buildDraftSessionKey(name: string): string {
  return `draft:${Date.now()}:${Math.random().toString(36).slice(2, 7)}:${name}`
}

function isRealtimeMessageRole(role: unknown): role is 'user' | 'assistant' | 'toolResult' {
  return role === 'user' || role === 'assistant' || role === 'toolResult'
}

// ========== Hook ==========

/** agents.list RPC 返回的单个 Agent 行 */
export interface GatewayAgentRow {
  id: string
  name?: string
  identity?: {
    name?: string
    theme?: string
    emoji?: string
    avatar?: string
    avatarUrl?: string
  }
}

/** agents.list RPC 返回结构 */
export interface AgentsListResult {
  defaultId: string
  mainKey: string
  scope: string
  agents: GatewayAgentRow[]
}

export interface UseGatewayWsReturn {
  status: WsStatus
  sessionKey: string | null
  errorMsg: string | null
  messages: ChatMessage[]
  historyLoading: boolean
  /** Gateway 进程是否处于运行状态（独立于 WS 连接状态） */
  gatewayRunning: boolean
  /** 是否正在流式输出 */
  isStreaming: boolean
  /** 会话列表 */
  sessions: SessionItem[]
  /** 握手时获取的默认 agentId */
  defaultAgentId: string
  /** 当前会话是否为本地草稿（首次发送前） */
  isDraftSession: boolean
  /** 当前会话绑定的 agentId（草稿态可修改） */
  currentSessionAgentId: string
  /** 发送聊天消息（支持附件） */
  sendMessage: (text: string, attachments?: AttachmentPayload[]) => boolean
  /** 中止当前流式生成 */
  abortMessage: () => void
  /** 新建会话：切换到 agent:<agentId>:<name> */
  newSession: (name: string, agentId?: string) => void
  /** 仅草稿会话可用：切换会话绑定的 agent */
  setDraftAgent: (agentId: string) => void
  /** 手动重连 */
  reconnect: () => void
  /** 切换到指定会话 */
  switchSession: (key: string) => void
  /** 删除会话，返回 Promise 供调用方处理结果 */
  deleteSession: (key: string) => Promise<void>
  /** 重置当前会话（清空历史），返回 Promise 供调用方处理结果 */
  resetSession: (targetKey?: string) => Promise<void>
  /** 刷新会话列表 */
  refreshSessions: (options?: { force?: boolean }) => void
  /** 通过 WS RPC 列出所有运行时 Agent（含隐式 main），WS 未就绪时返回 null */
  listAgents: () => Promise<AgentsListResult | null>
  /** 通用 WS RPC 调用，WS 未就绪时 reject */
  callRpc: (method: string, params: unknown) => Promise<unknown>
}

export function useGatewayWs(): UseGatewayWsReturn {
  const [status, setStatus] = useState<WsStatus>('disconnected')
  const [sessionKey, setSessionKey] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [gatewayRunning, setGatewayRunning] = useState(false)
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [defaultAgentId, setDefaultAgentId] = useState('main')
  const [draftSessions, setDraftSessions] = useState<Record<string, DraftSessionState>>({})
  const messagesRef = useRef<ChatMessage[]>([])

  const wsRef = useRef<WebSocket | null>(null)
  const pendingRef = useRef<
    Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
  >(new Map())
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const challengeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshSessionsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadHistoryRef = useRef<
    ((key: string, options?: { silent?: boolean; force?: boolean }) => void) | null
  >(null)
  const reconnectCountRef = useRef(0)
  const intentionalCloseRef = useRef(false)
  const currentRunIdRef = useRef<string | null>(null)
  const activeRunSessionKeyRef = useRef<string | null>(null)
  const abortRequestedSessionKeyRef = useRef<string | null>(null)
  const abortedRunIdsRef = useRef<Set<string>>(new Set())
  const portRef = useRef<number>(0)
  const tokenRef = useRef<string>('')
  const sessionKeyRef = useRef<string | null>(null)
  const statusRef = useRef<WsStatus>('disconnected')
  /** 握手时记录的主会话 key（用于删除当前会话后的回退） */
  const mainSessionKeyRef = useRef<string | null>(null)
  /** 最多尝试 1 次 origin 自动修复 */
  const autoPairAttemptsRef = useRef(0)
  /** 最多尝试 1 次 TOKEN_MISMATCH 重试 */
  const retryMismatchRef = useRef(0)
  /** 本机 deviceId（用于 storeDeviceToken / clearDeviceToken） */
  const deviceIdRef = useRef('')
  /** doConnect 函数引用（用于打破循环依赖） */
  const doConnectRef = useRef<(() => void) | null>(null)
  /** autoPairAndReconnect 函数引用（用于打破循环依赖） */
  const autoPairAndReconnectRef = useRef<(() => Promise<void>) | null>(null)
  /** 最近浏览过的会话历史缓存，减少切换闪白 */
  const messageCacheRef = useRef<Map<string, ChatMessage[]>>(new Map())
  /** 飞书 peer id -> 展示名缓存，用于会话列表和消息正文去掉 open_id */
  const feishuPeerNameRef = useRef<Map<string, string>>(new Map())
  /** 本地草稿会话（首次发送前） */
  const draftSessionsRef = useRef<Record<string, DraftSessionState>>({})
  const sessionUpdatedAtRef = useRef<Map<string, number>>(new Map())

  const writeDebugLog = useCallback((message: string, data?: unknown): void => {
    const suffix = data === undefined ? '' : ` | ${stringifyForDebugLog(data)}`
    window.api.log
      .write({ level: 'debug', tag: 'chat-debug', message: `${message}${suffix}` })
      .catch(() => {})
  }, [])

  const loadGatewayAuthContext = useCallback(async (): Promise<void> => {
    const [token, deviceId] = await Promise.all([
      window.api.gateway.getToken(),
      window.api.gateway.getDeviceId(),
    ])
    tokenRef.current = token
    deviceIdRef.current = deviceId
  }, [])

  // sessionKey 同步到 ref，避免闭包问题
  useEffect(() => {
    sessionKeyRef.current = sessionKey
  }, [sessionKey])
  useEffect(() => {
    statusRef.current = status
  }, [status])
  useEffect(() => {
    draftSessionsRef.current = draftSessions
  }, [draftSessions])
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // ========== 工具函数 ==========

  const send = useCallback((frame: WsFrame): void => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(frame))
    }
  }, [])

  const rpc = useCallback(
    (method: string, params: unknown): Promise<unknown> => {
      return new Promise((resolve, reject) => {
        if (wsRef.current?.readyState !== WebSocket.OPEN) {
          reject(new Error('WebSocket not connected'))
          return
        }
        const id = nextId(method.replace('.', '-'))
        pendingRef.current.set(id, { resolve, reject })
        send({ type: 'req', id, method, params })
        // 30s 超时
        setTimeout(() => {
          if (pendingRef.current.has(id)) {
            pendingRef.current.delete(id)
            reject(new Error(`RPC timeout: ${method}`))
          }
        }, 30000)
      })
    },
    [send]
  )

  const shouldIgnoreAbortedEvent = useCallback(
    (runId?: string | null, eventSessionKey?: string | null): boolean => {
      if (runId && abortedRunIdsRef.current.has(runId)) return true
      const abortSessionKey = abortRequestedSessionKeyRef.current
      return Boolean(abortSessionKey && eventSessionKey && abortSessionKey === eventSessionKey)
    },
    []
  )

  const resolveAndCacheFeishuPeers = useCallback(
    async (targets: Array<Pick<FeishuPeerTarget, 'kind' | 'id'>>): Promise<void> => {
      const uniqueTargets = Array.from(
        new Map(
          targets
            .map((target) => ({
              kind: target.kind,
              id: target.id.trim(),
            }))
            .filter((target) => target.id.length > 0)
            .map((target) => [feishuPeerCacheKey(target.kind, target.id), target])
        ).values()
      )

      const missingTargets = uniqueTargets.filter(
        (target) => !feishuPeerNameRef.current.has(feishuPeerCacheKey(target.kind, target.id))
      )
      if (missingTargets.length === 0) return

      try {
        const results = await window.api.channel.resolveFeishuPeers(missingTargets)
        for (const result of results as FeishuPeerResolution[]) {
          if (!result.displayName?.trim()) continue
          feishuPeerNameRef.current.set(
            feishuPeerCacheKey(result.kind, result.id),
            result.displayName.trim()
          )
        }
      } catch {
        // 解析姓名失败不影响聊天主流程，显示层会退化成“飞书用户”。
      }
    },
    []
  )

  const updateSessionMessages = useCallback(
    (
      targetSessionKey: string | null | undefined,
      updater: (prev: ChatMessage[]) => ChatMessage[]
    ): void => {
      const key = targetSessionKey || sessionKeyRef.current || ''
      const isVisible = Boolean(!key || key === sessionKeyRef.current)
      const previous = key
        ? messageCacheRef.current.get(key) || (isVisible ? messagesRef.current : [])
        : messagesRef.current
      const next = updater(previous)

      if (key) messageCacheRef.current.set(key, next)

      if (isVisible) {
        messagesRef.current = next
        setMessages(next)
      }
    },
    []
  )

  const markStreamingInterrupted = useCallback(
    (key: string): void => {
      updateSessionMessages(key, (prev) => {
        let touched = false
        const next = prev.map((message) => {
          const hasLoadingTool = message.toolCalls?.some(
            (toolCall) => toolCall.status === 'loading'
          )
          if (message.role !== 'assistant' || (!message.streaming && !hasLoadingTool)) {
            return message
          }
          touched = true
          return {
            ...message,
            content: message.content?.trim() ? message.content : '已中断当前任务。',
            toolCalls: message.toolCalls?.map((toolCall) =>
              toolCall.status === 'loading'
                ? {
                    ...toolCall,
                    status: 'error' as const,
                    resultText: toolCall.resultText || '已中断',
                  }
                : toolCall
            ),
            streaming: false,
          }
        })
        const result = touched
          ? next
          : [
              ...prev,
              {
                id: nextId('abort'),
                role: 'assistant' as const,
                content: '已中断当前任务。',
              },
            ]
        return result
      })
    },
    [updateSessionMessages]
  )

  const flushPending = useCallback((): void => {
    for (const [, cb] of pendingRef.current) {
      cb.reject(new Error('连接已断开'))
    }
    pendingRef.current.clear()
  }, [])

  const stopPing = useCallback((): void => {
    if (pingTimerRef.current) {
      clearInterval(pingTimerRef.current)
      pingTimerRef.current = null
    }
  }, [])

  const startPing = useCallback((): void => {
    stopPing()
    pingTimerRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send('{"type":"ping"}')
      }
    }, PING_INTERVAL_MS)
  }, [stopPing])

  // ========== 会话列表 ==========

  const refreshSessions = useCallback(
    (options?: { force?: boolean }): void => {
      const throttle = getGatewayRefreshThrottleState()
      if (throttle.sessionsInFlight) return
      const now = Date.now()
      if (!options?.force && now - throttle.lastSessionsRefreshAt < MIN_SESSION_REFRESH_GAP_MS)
        return
      throttle.lastSessionsRefreshAt = now
      throttle.sessionsInFlight = true
      rpc('sessions.list', { limit: 50 })
        .then((result) => {
          const raw = result as { sessions?: unknown[] } | unknown[]
          const list: unknown[] = Array.isArray(raw)
            ? raw
            : (raw as { sessions?: unknown[] }).sessions || []
          const feishuTargets = new Map<string, FeishuPeerTarget>()
          const items: SessionItem[] = list.map((s) => {
            const session = s as RawSessionListItem
            const key = session.sessionKey || session.key || ''
            const target = getFeishuTargetFromSession(key, session)
            if (target) feishuTargets.set(key, target)
            return {
              key,
              label: pickProvidedSessionLabel(session, key) || parseSessionLabel(key),
              updatedAt: session.updatedAt || session.lastActivity,
            }
          })
          const currentKey = sessionKeyRef.current
          const currentItem = currentKey ? items.find((item) => item.key === currentKey) : undefined
          const currentUpdatedAt = toNumber(currentItem?.updatedAt)
          const previousCurrentUpdatedAt = currentKey
            ? sessionUpdatedAtRef.current.get(currentKey)
            : undefined
          const currentSessionChanged = Boolean(
            currentKey &&
            currentUpdatedAt !== undefined &&
            (previousCurrentUpdatedAt === undefined || currentUpdatedAt > previousCurrentUpdatedAt)
          )

          for (const item of items) {
            const updatedAt = toNumber(item.updatedAt)
            if (updatedAt !== undefined) sessionUpdatedAtRef.current.set(item.key, updatedAt)
          }
          const draftItems: SessionItem[] = Object.entries(draftSessionsRef.current).map(
            ([key, draft]) => ({
              key,
              label: draft.name,
              updatedAt: draft.createdAt,
            })
          )
          setSessions((prev) => [
            ...draftItems,
            ...sortSessionsByActivity(items, prev.filter((item) => !isDraftSessionKey(item.key))),
          ])
          if (currentKey && currentSessionChanged) {
            loadHistoryRef.current?.(currentKey, { silent: true, force: true })
          }

          if (feishuTargets.size > 0) {
            window.api.channel
              .resolveFeishuPeers(
                Array.from(
                  new Map(
                    Array.from(feishuTargets.values()).map((target) => [
                      `${target.kind}:${target.id}`,
                      { kind: target.kind, id: target.id },
                    ])
                  ).values()
                )
              )
              .then((results: FeishuPeerResolution[]) => {
                for (const result of results) {
                  if (result.displayName?.trim()) {
                    feishuPeerNameRef.current.set(
                      feishuPeerCacheKey(result.kind, result.id),
                      result.displayName.trim()
                    )
                  }
                }
                setSessions((prev) =>
                  prev.map((session) => {
                    const target = feishuTargets.get(session.key)
                    if (!target) return session
                    const displayName = feishuPeerNameRef.current.get(
                      feishuPeerCacheKey(target.kind, target.id)
                    )
                    if (!displayName) return session
                    return {
                      ...session,
                      label: formatFeishuPeerLabel(target.kind, displayName),
                    }
                  })
                )
              })
              .catch(() => {})
          }
        })
        .catch(() => {})
        .finally(() => {
          throttle.sessionsInFlight = false
        })
    },
    [rpc]
  )

  const scheduleRefreshSessions = useCallback(
    (delayMs = 500): void => {
      if (refreshSessionsTimerRef.current) return
      refreshSessionsTimerRef.current = setTimeout(() => {
        refreshSessionsTimerRef.current = null
        refreshSessions()
      }, delayMs)
    },
    [refreshSessions]
  )

  const loadHistory = useCallback(
    (key: string, options?: { silent?: boolean; force?: boolean }): void => {
      const silent = options?.silent === true
      const throttle = getGatewayRefreshThrottleState()
      if (activeRunSessionKeyRef.current === key || throttle.historyInFlight.has(key)) return
      if (silent && !options?.force) {
        const now = Date.now()
        const lastAt = throttle.lastSilentHistoryRefreshAt.get(key) ?? 0
        if (now - lastAt < MIN_SILENT_HISTORY_REFRESH_GAP_MS) return
        throttle.lastSilentHistoryRefreshAt.set(key, now)
      }
      throttle.historyInFlight.add(key)
      if (!silent) setHistoryLoading(true)
      rpc('chat.history', { sessionKey: key, limit: CHAT_HISTORY_LIMIT })
        .then(async (result) => {
          const data = result as { messages?: unknown[] } | null
          const rawMessages: unknown[] = sortRawHistoryMessages(data?.messages || [])
          await resolveAndCacheFeishuPeers(collectFeishuSenderTargets(rawMessages))
          const loaded: ChatMessage[] = []
          const toolMap = new Map<string, { messageIndex: number; toolIndex: number }>()

          for (const entry of rawMessages) {
            const msg = entry as {
              id?: string
              role?: string
              content?: string | ContentBlock[]
              timestamp?: number
              attachments?: AttachmentPayload[]
              usage?: unknown
              durationMs?: number
              model?: string
              provider?: string
              toolCallId?: string
              toolName?: string
              isError?: boolean
            }

            if (msg.role === 'assistant') {
              const normalized = normalizeAssistantContent(msg.content)
              const attachments = mergeAttachments(msg.attachments, normalized.attachments)
              if (
                !normalized.text &&
                !normalized.thinking &&
                !normalized.toolCalls?.length &&
                !attachments?.length
              ) {
                continue
              }

              const prev = loaded[loaded.length - 1]
              const prevIsAssistant = prev?.role === 'assistant'
              const prevHasText = Boolean(prevIsAssistant && prev.content?.trim())
              const incomingHasText = Boolean(normalized.text?.trim())
              const prevHasMeta = Boolean(
                prevIsAssistant &&
                (prev.thinking?.trim() || prev.toolCalls?.length || prev.attachments?.length)
              )
              const incomingHasMeta = Boolean(
                normalized.thinking?.trim() || normalized.toolCalls?.length || attachments?.length
              )

              // 历史里同一轮 assistant 可能被拆成多段（工具段 + 正文段），这里合并为一个气泡
              const shouldMergeWithPrev =
                prevIsAssistant &&
                ((!prevHasText && prevHasMeta && incomingHasText) ||
                  (prevHasText && !incomingHasText && incomingHasMeta) ||
                  (!prevHasText && !incomingHasText))

              if (shouldMergeWithPrev && prevIsAssistant) {
                prev.content = incomingHasText ? normalized.text : prev.content
                if (normalized.thinking) {
                  prev.thinking = prev.thinking
                    ? prev.thinking.includes(normalized.thinking)
                      ? prev.thinking
                      : `${prev.thinking}\n\n${normalized.thinking}`
                    : normalized.thinking
                }
                prev.toolCalls = mergeToolCalls(prev.toolCalls, normalized.toolCalls)
                prev.attachments = mergeAttachments(prev.attachments, attachments)
                prev.usage = normalizeUsage(msg.usage) ?? prev.usage
                prev.durationMs = toNumber(msg.durationMs) ?? prev.durationMs
                prev.model = pickText(msg.model, prev.model) ?? prev.model
                prev.provider = pickText(msg.provider, prev.provider) ?? prev.provider

                const messageIndex = loaded.length - 1
                prev.toolCalls?.forEach((toolCall, toolIndex) => {
                  toolMap.set(toolCall.id, { messageIndex, toolIndex })
                })
                continue
              }

              const message: ChatMessage = {
                id: msg.id || nextId('hist'),
                role: 'assistant',
                content: normalized.text,
                timestamp: getRawHistoryTimestamp(entry),
                thinking: normalized.thinking,
                toolCalls: normalized.toolCalls,
                attachments,
                usage: normalizeUsage(msg.usage),
                durationMs: toNumber(msg.durationMs),
                model: pickText(msg.model),
                provider: pickText(msg.provider),
              }
              const messageIndex = loaded.push(message) - 1
              normalized.toolCalls?.forEach((toolCall, toolIndex) => {
                toolMap.set(toolCall.id, { messageIndex, toolIndex })
              })
              continue
            }

            if (msg.role === 'toolResult') {
              const toolCallId = pickText(msg.toolCallId)
              const link = toolCallId ? toolMap.get(toolCallId) : undefined
              if (!link) continue
              const target = loaded[link.messageIndex]
              if (!target?.toolCalls?.[link.toolIndex]) continue
              const nextToolCalls = [...target.toolCalls]
              const current = nextToolCalls[link.toolIndex]
              nextToolCalls[link.toolIndex] = {
                ...current,
                name: pickText(current.name, msg.toolName) || current.name,
                resultText: extractToolResultText(msg.content),
                status: msg.isError ? 'error' : 'success',
              }
              target.toolCalls = nextToolCalls
              continue
            }

            if (msg.role === 'user') {
              const rawText = extractText(msg.content as string | ContentBlock[] | undefined)
              const text = formatFeishuIncomingUserText(rawText, feishuPeerNameRef.current)
              if (!text && !msg.attachments?.length) continue
              loaded.push({
                id: msg.id || nextId('hist'),
                role: 'user',
                content: text,
                timestamp: getRawHistoryTimestamp(entry),
                attachments: msg.attachments,
                usage: normalizeUsage(msg.usage),
                durationMs: toNumber(msg.durationMs),
                model: pickText(msg.model),
                provider: pickText(msg.provider),
              })
            }
          }
          if (activeRunSessionKeyRef.current === key) {
            const current = messageCacheRef.current.get(key)
            if (current?.length) {
              if (sessionKeyRef.current === key) {
                messagesRef.current = current
                setMessages(current)
              }
              return
            }
          }

          const settledLoaded = closeDanglingToolCallsBeforeFailures(loaded)
          const currentMessages = messageCacheRef.current.get(key)
          const nextMessages = silent
            ? mergeLoadedHistoryWithLocalTail(settledLoaded, currentMessages)
            : settledLoaded
          messageCacheRef.current.set(key, nextMessages)
          if (sessionKeyRef.current === key) {
            messagesRef.current = nextMessages
            setMessages(nextMessages)
          }
        })
        .catch(() => {})
        .finally(() => {
          throttle.historyInFlight.delete(key)
          if (!silent && sessionKeyRef.current === key) {
            setHistoryLoading(false)
          }
        })
    },
    [resolveAndCacheFeishuPeers, rpc]
  )
  loadHistoryRef.current = loadHistory

  // ========== 握手 ==========

  /**
   * 握手成功回调（从 pending resolve 提取为独立 useCallback，稳定引用）
   * 1. 从 snapshot 取会话 key / defaultAgentId
   * 2. 存储 Gateway 颁发的 deviceToken
   * 3. 重置修复计数
   */
  const handleSessionActivityItems = useCallback(
    (incomingItems: SessionItem[]): void => {
      const changedItems: SessionItem[] = []
      for (const item of incomingItems) {
        const updatedAt = toNumber(item.updatedAt)
        if (updatedAt === undefined) continue
        const previousUpdatedAt = sessionUpdatedAtRef.current.get(item.key)
        if (previousUpdatedAt !== undefined && updatedAt <= previousUpdatedAt) continue
        sessionUpdatedAtRef.current.set(item.key, updatedAt)
        changedItems.push(item)
      }

      if (changedItems.length === 0) return

      setSessions((prev) => mergeSessionItems(prev, changedItems))
      scheduleRefreshSessions(1000)

      const currentKey = sessionKeyRef.current
      if (currentKey && changedItems.some((item) => item.key === currentKey)) {
        loadHistory(currentKey, { silent: true, force: true })
      }
    },
    [loadHistory, scheduleRefreshSessions]
  )

  const handleHealthEvent = useCallback(
    (payload: unknown): void => {
      handleSessionActivityItems(collectHealthSessionItems(payload))
    },
    [handleSessionActivityItems]
  )

  const handleConnectSuccess = useCallback(
    (payload: unknown): void => {
      const p = payload as {
        snapshot?: { sessionDefaults?: { mainSessionKey?: string; defaultAgentId?: string } }
        auth?: { deviceToken?: string; role?: string; scopes?: string[] }
      }
      const defaults = p?.snapshot?.sessionDefaults
      const mainKey = defaults?.mainSessionKey || `agent:${defaults?.defaultAgentId || 'main'}:main`
      const key = readLastSessionKey() || mainKey
      mainSessionKeyRef.current = mainKey
      setDefaultAgentId(defaults?.defaultAgentId || 'main')
      setSessionKey(key)
      sessionKeyRef.current = key
      setStatus('ready')
      setErrorMsg(null)
      reconnectCountRef.current = 0
      startPing()

      // 握手成功：存储 Gateway 颁发的 deviceToken，下次重连可复用
      if (p?.auth?.deviceToken && deviceIdRef.current) {
        window.api.gateway.storeDeviceToken(
          deviceIdRef.current,
          p.auth.role ?? 'operator',
          p.auth.deviceToken,
          p.auth.scopes ?? []
        )
      }
      // 成功后重置修复计数，允许下次再触发
      retryMismatchRef.current = 0
      autoPairAttemptsRef.current = 0

      setTimeout(() => {
        refreshSessions()
        loadHistory(key)
      }, 100)
    },
    [startPing, refreshSessions, loadHistory]
  )

  /**
   * 握手失败回调（从 pending reject 提取为独立 useCallback）
   * - TOKEN_MISMATCH → 清除 deviceToken，用 gatewayToken 重签（最多 1 次）
   * - NOT_PAIRED / origin not allowed → 自动修复 allowedOrigins（最多 1 次）
   * - 其他 → 显示错误
   */
  const handleConnectError = useCallback(
    (err: Error): void => {
      const msg = err.message
      if (/TOKEN_MISMATCH/i.test(msg) && retryMismatchRef.current < 1) {
        retryMismatchRef.current++
        window.api.gateway
          .clearDeviceToken(deviceIdRef.current, 'operator')
          .then(() => loadGatewayAuthContext())
          .finally(() => doConnectRef.current?.())
        return
      }
      if (
        (/NOT_PAIRED|PAIRING_REQUIRED/i.test(msg) || /origin not allowed/i.test(msg)) &&
        autoPairAttemptsRef.current < 1
      ) {
        autoPairAttemptsRef.current++
        autoPairAndReconnectRef.current?.()
        return
      }
      setStatus('error')
      setErrorMsg(msg)
    },
    [loadGatewayAuthContext]
  ) // 稳定引用，通过 ref 访问 doConnect / autoPairAndReconnect

  /**
   * 发送 Ed25519 connect 握手帧（异步，通过 IPC 请求主进程构建帧）
   * @param nonce - 来自 connect.challenge 事件的随机数（超时后传空字符串）
   */
  const sendConnectFrame = useCallback(
    async (nonce: string): Promise<void> => {
      try {
        const frame = await window.api.gateway.buildConnectFrame(nonce)
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const id = (frame as { id: string }).id
          pendingRef.current.set(id, {
            resolve: handleConnectSuccess,
            reject: handleConnectError,
          })
          wsRef.current.send(JSON.stringify(frame))
          setStatus('handshaking')
        }
      } catch (e) {
        console.error('[ws] buildConnectFrame failed:', e)
      }
    },
    [handleConnectSuccess, handleConnectError]
  )

  // ========== 事件处理 ==========

  const handleChatEvent = useCallback(
    (payload: ChatEventPayload): void => {
      const normalized = normalizeAssistantContent(payload.message?.content)
      const model = pickText(payload.model, payload.message?.model)
      const provider = pickText(payload.provider, payload.message?.provider)
      const usage = normalizeUsage(payload.usage)
      const durationMs = toNumber(payload.durationMs)
      writeDebugLog(`chat-event state=${payload.state} runId=${payload.runId}`, {
        payload,
        normalized: {
          textLength: normalized.text.length,
          thinking: Boolean(normalized.thinking),
          tools: normalized.toolCalls?.length || 0,
          attachments: normalized.attachments?.length || 0,
        },
      })

      if (payload.state === 'delta') {
        const runId = pickText(payload.runId)
        const eventSessionKey = pickText(payload.sessionKey)
        if (shouldIgnoreAbortedEvent(runId, eventSessionKey)) return
        const targetSessionKey = eventSessionKey || sessionKeyRef.current || ''
        const isVisibleSession = !targetSessionKey || targetSessionKey === sessionKeyRef.current
        if (isVisibleSession) {
          currentRunIdRef.current = runId || currentRunIdRef.current
          activeRunSessionKeyRef.current = targetSessionKey || activeRunSessionKeyRef.current
          setIsStreaming(true)
        }
        updateSessionMessages(targetSessionKey, (prev) => {
          // 优先按 runId 命中，避免 lifecycle 抢先结束后产生重复气泡
          const idxByRunId = prev.findIndex((m) => m.role === 'assistant' && m.id === payload.runId)
          const idxStreaming =
            idxByRunId >= 0 ? -1 : findLastStreamingAssistantIndex(prev)
          const idx = idxByRunId >= 0 ? idxByRunId : idxStreaming
          if (idx >= 0) {
            const updated = [...prev]
            updated[idx] = {
              ...updated[idx],
              id: payload.runId || updated[idx].id,
              content: normalized.text || updated[idx].content,
              thinking: mergeThinkingText(updated[idx].thinking, normalized.thinking),
              toolCalls: normalized.toolCalls ?? updated[idx].toolCalls,
              attachments: mergeAttachments(updated[idx].attachments, normalized.attachments),
              model,
              provider,
            }
            return updated
          }
          // 新建 streaming 气泡
          return [
            ...prev,
            {
              id: payload.runId,
              role: 'assistant',
              content: normalized.text,
              timestamp: Date.now(),
              thinking: normalized.thinking,
              toolCalls: normalized.toolCalls,
              attachments: normalized.attachments,
              streaming: true,
              model,
              provider,
            },
          ]
        })
        if (!isVisibleSession) scheduleRefreshSessions(500)
      } else if (payload.state === 'final') {
        const runId = pickText(payload.runId)
        const eventSessionKey = pickText(payload.sessionKey)
        if (shouldIgnoreAbortedEvent(runId, eventSessionKey)) return
        const currentSessionKey = eventSessionKey || sessionKeyRef.current || ''
        const isVisibleSession = !currentSessionKey || currentSessionKey === sessionKeyRef.current
        const isTrackedRunSession = Boolean(
          currentSessionKey && activeRunSessionKeyRef.current === currentSessionKey
        )
        if (runId) abortedRunIdsRef.current.delete(runId)
        if (isVisibleSession || isTrackedRunSession) {
          currentRunIdRef.current = null
          activeRunSessionKeyRef.current = null
          abortRequestedSessionKeyRef.current = null
        }
        if (isVisibleSession) {
          setIsStreaming(false)
        }
        updateSessionMessages(currentSessionKey, (prev) => {
          const idxByRunId = prev.findIndex((m) => m.role === 'assistant' && m.id === payload.runId)
          const idxStreaming =
            idxByRunId >= 0 ? -1 : findLastStreamingAssistantIndex(prev)
          const idx = idxByRunId >= 0 ? idxByRunId : idxStreaming
          if (idx >= 0) {
            const updated = [...prev]
            updated[idx] = {
              ...updated[idx],
              id: payload.runId || updated[idx].id,
              content: normalized.text || updated[idx].content,
              thinking: mergeThinkingText(updated[idx].thinking, normalized.thinking),
              toolCalls: normalized.toolCalls ?? updated[idx].toolCalls,
              attachments: mergeAttachments(updated[idx].attachments, normalized.attachments),
              streaming: false,
              usage,
              durationMs,
              model,
              provider,
            }
            return updated
          }
          return prev
        })
        // 消息完成后刷新会话列表（更新时间戳排序）
        scheduleRefreshSessions(800)
        requestAccountRefresh()
        // realtime 帧可能不带 thinking/usage，静默回读 history 补齐元信息
        if (currentSessionKey) {
          setTimeout(() => {
            loadHistory(currentSessionKey, { silent: true })
          }, 350)
        }
      } else if (payload.state === 'aborted') {
        const runId = pickText(payload.runId)
        const eventSessionKey = pickText(payload.sessionKey)
        const targetSessionKey = eventSessionKey || sessionKeyRef.current || ''
        const isVisibleSession = !targetSessionKey || targetSessionKey === sessionKeyRef.current
        const isTrackedRunSession = Boolean(
          targetSessionKey && activeRunSessionKeyRef.current === targetSessionKey
        )
        if (runId) abortedRunIdsRef.current.delete(runId)
        if (isVisibleSession || isTrackedRunSession) {
          abortRequestedSessionKeyRef.current = null
          currentRunIdRef.current = null
          activeRunSessionKeyRef.current = null
        }
        if (isVisibleSession) {
          setIsStreaming(false)
        }
        if (targetSessionKey) markStreamingInterrupted(targetSessionKey)
        updateSessionMessages(targetSessionKey, (prev) =>
          prev.map((m) =>
            m.streaming ? { ...m, content: normalized.text || m.content, streaming: false } : m
          )
        )
        scheduleRefreshSessions(800)
        requestAccountRefresh()
      } else if (payload.state === 'error') {
        const runId = pickText(payload.runId)
        const eventSessionKey = pickText(payload.sessionKey)
        if (shouldIgnoreAbortedEvent(runId, eventSessionKey)) return
        const targetSessionKey = eventSessionKey || sessionKeyRef.current || ''
        const isVisibleSession = !targetSessionKey || targetSessionKey === sessionKeyRef.current
        const isTrackedRunSession = Boolean(
          targetSessionKey && activeRunSessionKeyRef.current === targetSessionKey
        )
        if (runId) abortedRunIdsRef.current.delete(runId)
        if (isVisibleSession || isTrackedRunSession) {
          currentRunIdRef.current = null
          activeRunSessionKeyRef.current = null
          abortRequestedSessionKeyRef.current = null
        }
        if (isVisibleSession) {
          setIsStreaming(false)
        }
        const errText = normalizeChatErrorText(payload.errorMessage || payload.error?.message)
        updateSessionMessages(targetSessionKey, (prev) => {
          const idxByRunId = runId
            ? prev.findIndex((m) => m.role === 'assistant' && m.id === runId)
            : -1
          const idxStreaming = idxByRunId >= 0 ? -1 : findLastStreamingAssistantIndex(prev)
          const idx = idxByRunId >= 0 ? idxByRunId : idxStreaming
          if (idx >= 0) {
            const next = [...prev]
            next[idx] = { ...next[idx], id: runId || next[idx].id, content: errText, streaming: false }
            return next
          }
          return [
            ...prev,
            {
              id: runId || nextId('agent-error'),
              role: 'assistant',
              content: errText,
              timestamp: Date.now(),
              streaming: false,
              model,
              provider,
            },
          ]
        })
        scheduleRefreshSessions(800)
        requestAccountRefresh()
      }
    },
    [
      loadHistory,
      markStreamingInterrupted,
      scheduleRefreshSessions,
      shouldIgnoreAbortedEvent,
      updateSessionMessages,
      writeDebugLog,
    ]
  )

  const handleRealtimeMessageEvent = useCallback(
    (messagePayload: RealtimeMessagePayload, containerPayload?: Record<string, unknown>): void => {
      const targetSessionKey = pickText(messagePayload.sessionKey, containerPayload?.sessionKey)
      const isVisibleSession = !targetSessionKey || targetSessionKey === sessionKeyRef.current
      const eventRunId = pickText(containerPayload?.runId, messagePayload.id)
      if (shouldIgnoreAbortedEvent(eventRunId, targetSessionKey)) return

      if (messagePayload.role === 'user') {
        const rawText = extractText(messagePayload.content)
        if (!rawText.trim()) return
        const parsedSender = parseFeishuSenderPrefix(rawText)
        const messageId = messagePayload.id || nextId('rt-user')
        const currentSessionKey = targetSessionKey || sessionKeyRef.current || ''
        updateSessionMessages(currentSessionKey, (prev) => {
          if (prev.some((m) => m.id === messageId)) return prev
          return [
            ...prev,
            {
              id: messageId,
              role: 'user' as const,
              content: formatFeishuIncomingUserText(rawText, feishuPeerNameRef.current),
              timestamp: Date.now(),
            },
          ]
        })
        scheduleRefreshSessions(500)

        if (
          parsedSender &&
          !feishuPeerNameRef.current.has(feishuPeerCacheKey('user', parsedSender.id))
        ) {
          resolveAndCacheFeishuPeers([{ kind: 'user', id: parsedSender.id }]).then(() => {
            updateSessionMessages(currentSessionKey, (prev) => {
              const next = prev.map((message) =>
                message.id === messageId
                  ? {
                      ...message,
                      content: formatFeishuIncomingUserText(rawText, feishuPeerNameRef.current),
                    }
                  : message
              )
              return next
            })
          })
        }
        return
      }

      if (messagePayload.role === 'assistant') {
        const normalized = normalizeAssistantContent(messagePayload.content)
        const model = pickText(messagePayload.model, containerPayload?.model)
        const provider = pickText(messagePayload.provider, containerPayload?.provider)
        const usage = normalizeUsage(messagePayload.usage ?? containerPayload?.usage)
        const durationMs = toNumber(messagePayload.durationMs ?? containerPayload?.durationMs)
        const isToolStep = /tooluse/i.test(pickText(messagePayload.stopReason) || '')
        writeDebugLog(
          `realtime-assistant id=${messagePayload.id || '-'} stop=${messagePayload.stopReason || '-'}`,
          {
            messagePayload,
            containerPayload,
            normalized: {
              textLength: normalized.text.length,
              thinking: Boolean(normalized.thinking),
              tools: normalized.toolCalls?.length || 0,
              attachments: normalized.attachments?.length || 0,
            },
          }
        )

        if (isVisibleSession && isToolStep) setIsStreaming(true)
        const currentSessionKey = targetSessionKey || sessionKeyRef.current || ''
        updateSessionMessages(currentSessionKey, (prev) => {
          const idxById = messagePayload.id
            ? prev.findIndex((m) => m.role === 'assistant' && m.id === messagePayload.id)
            : -1
          const idxStreaming =
            idxById >= 0 ? -1 : findLastStreamingAssistantIndex(prev)
          const idx = idxById >= 0 ? idxById : idxStreaming

          if (idx >= 0) {
            const updated = [...prev]
            updated[idx] = {
              ...updated[idx],
              id: messagePayload.id || updated[idx].id,
              content: normalized.text || updated[idx].content,
              thinking: normalized.thinking ?? updated[idx].thinking,
              toolCalls: normalized.toolCalls ?? updated[idx].toolCalls,
              attachments: mergeAttachments(updated[idx].attachments, normalized.attachments),
              usage: usage ?? updated[idx].usage,
              durationMs: durationMs ?? updated[idx].durationMs,
              model: model ?? updated[idx].model,
              provider: provider ?? updated[idx].provider,
              streaming: isToolStep ? true : updated[idx].streaming,
            }
            return updated
          }

          return [
            ...prev,
            {
              id: messagePayload.id || nextId('rt-ai'),
              role: 'assistant',
              content: normalized.text,
              timestamp: Date.now(),
              thinking: normalized.thinking,
              toolCalls: normalized.toolCalls,
              attachments: normalized.attachments,
              usage,
              durationMs,
              model,
              provider,
              streaming: isToolStep,
            },
          ]
        })
        if (!isVisibleSession) scheduleRefreshSessions(500)
        return
      }

      if (messagePayload.role === 'toolResult') {
        const toolCallId = pickText(messagePayload.toolCallId)
        if (!toolCallId) return
        writeDebugLog(`realtime-tool-result toolCallId=${toolCallId}`, {
          messagePayload,
          containerPayload,
        })
        const currentSessionKey = targetSessionKey || sessionKeyRef.current || ''
        updateSessionMessages(currentSessionKey, (prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            const message = prev[i]
            if (message.role !== 'assistant' || !message.toolCalls?.length) continue
            const toolIdx = message.toolCalls.findIndex((t) => t.id === toolCallId)
            if (toolIdx < 0) continue

            const next = [...prev]
            const nextToolCalls = [...message.toolCalls]
            const currentTool = nextToolCalls[toolIdx]
            nextToolCalls[toolIdx] = {
              ...currentTool,
              name: pickText(currentTool.name, messagePayload.toolName) || currentTool.name,
              resultText: extractToolResultText(messagePayload.content),
              status: messagePayload.isError ? 'error' : 'success',
            }
            next[i] = { ...message, toolCalls: nextToolCalls }
            return next
          }
          return prev
        })
      }
    },
    [
      resolveAndCacheFeishuPeers,
      scheduleRefreshSessions,
      shouldIgnoreAbortedEvent,
      updateSessionMessages,
      writeDebugLog,
    ]
  )

  const handleAgentToolEvent = useCallback(
    (payload: AgentToolEventPayload): void => {
      if (payload.stream !== 'tool') return
      const targetSessionKey = pickText(payload.sessionKey)
      const isVisibleSession = !targetSessionKey || targetSessionKey === sessionKeyRef.current
      const eventRunId = pickText(payload.runId)
      if (shouldIgnoreAbortedEvent(eventRunId, targetSessionKey)) return

      const data = payload.data || {}
      const toolCallId = pickText(data.toolCallId)
      if (!toolCallId) return
      const phase = pickText(data.phase) || ''
      const toolName = pickText(data.name) || 'tool'
      const argsText = phase === 'start' ? toJsonText(data.args) : undefined
      const outputText =
        phase === 'update'
          ? toJsonText(data.partialResult)
          : phase === 'result'
            ? toJsonText(data.result)
            : undefined

      writeDebugLog(
        `agent-tool runId=${payload.runId || '-'} phase=${phase || '-'} id=${toolCallId}`,
        {
          payload,
          parsed: {
            toolCallId,
            toolName,
            phase,
            hasArgs: Boolean(argsText),
            hasOutput: Boolean(outputText),
          },
        }
      )

      if (isVisibleSession) setIsStreaming(true)
      const currentSessionKey = targetSessionKey || sessionKeyRef.current || ''
      updateSessionMessages(currentSessionKey, (prev) => {
        const streamingIdx = findLastStreamingAssistantIndex(prev)
        const idx = streamingIdx >= 0 ? streamingIdx : prev.length
        const next = [...prev]
        if (idx === prev.length) {
          next.push({
            id: pickText(payload.runId) || nextId('tool-run'),
            role: 'assistant',
            content: '',
            streaming: true,
            toolCalls: [],
          })
        }
        const base = next[idx]
        const currentToolCalls = base.toolCalls ? [...base.toolCalls] : []
        const toolIdx = currentToolCalls.findIndex((t) => t.id === toolCallId)

        if (toolIdx < 0) {
          currentToolCalls.push({
            id: toolCallId,
            name: toolName,
            argumentsText: argsText,
            resultText: outputText,
            status: phase === 'result' ? 'success' : 'loading',
          })
        } else {
          const current = currentToolCalls[toolIdx]
          currentToolCalls[toolIdx] = {
            ...current,
            name: toolName || current.name,
            argumentsText: argsText ?? current.argumentsText,
            resultText: outputText ?? current.resultText,
            status: phase === 'result' ? 'success' : 'loading',
          }
        }

        next[idx] = {
          ...base,
          id: pickText(payload.runId) || base.id,
          toolCalls: currentToolCalls,
          streaming: true,
        }
        return next
      })
      if (!isVisibleSession) scheduleRefreshSessions(500)
    },
    [scheduleRefreshSessions, shouldIgnoreAbortedEvent, updateSessionMessages, writeDebugLog]
  )

  const handleMessage = useCallback(
    (raw: string): void => {
      let frame: WsFrame
      try {
        frame = JSON.parse(raw)
      } catch {
        return
      }

      // connect.challenge → 发握手帧，携带 nonce 进行 Ed25519 签名
      if (frame.type === 'event' && frame.event === 'connect.challenge') {
        if (challengeTimerRef.current) {
          clearTimeout(challengeTimerRef.current)
          challengeTimerRef.current = null
        }
        const nonce = (frame.payload as { nonce?: string })?.nonce ?? ''
        sendConnectFrame(nonce)
        return
      }

      // RPC 响应
      if (frame.type === 'res' && frame.id) {
        const cb = pendingRef.current.get(frame.id)
        if (cb) {
          pendingRef.current.delete(frame.id)
          if (frame.ok) {
            cb.resolve(frame.payload)
          } else {
            cb.reject(new Error(frame.error?.message || frame.error?.code || 'RPC error'))
          }
        }
        return
      }

      // chat 事件（流式输出）
      if (frame.type === 'event' && frame.event === 'tick') {
        return
      }

      if (frame.type === 'event' && frame.event === 'health') {
        handleHealthEvent(frame.payload)
        return
      }

      if (frame.type === 'event' && frame.event === 'chat') {
        writeDebugLog('ws-event-full chat', frame)
        handleChatEvent(frame.payload as ChatEventPayload)
        return
      }

      // 兜底：某些 runtime 会把 assistant/toolResult 作为独立 event 推送
      if (frame.type === 'event' && frame.payload && typeof frame.payload === 'object') {
        const payload = frame.payload as Record<string, unknown>
        const sessionItem = toSessionItem(payload as RawSessionListItem)
        if (sessionItem) handleSessionActivityItems([sessionItem])
        writeDebugLog(`ws-event-full ${frame.event || '-'}`, frame)
        writeDebugLog(
          `ws-event event=${frame.event || '-'} keys=${Object.keys(payload).join(',')}`,
          payload
        )

        const nestedData =
          payload.data && typeof payload.data === 'object'
            ? (payload.data as Record<string, unknown>)
            : undefined
        if (frame.event === 'agent' && nestedData) {
          writeDebugLog(`agent-data keys=${Object.keys(nestedData).join(',')}`, nestedData)
          const agentStream = pickText(payload.stream, nestedData.stream)
          handleAgentToolEvent({
            runId: pickText(payload.runId, nestedData.runId),
            sessionKey: pickText(payload.sessionKey, nestedData.sessionKey),
            stream: agentStream,
            // agent 事件里 data 字段本身就是工具数据（phase/name/toolCallId/...）
            data: nestedData as AgentToolEventPayload['data'],
          })

          // agent assistant 流：payload.stream=assistant，文本增量在 data.text/data.delta
          if (agentStream === 'assistant') {
            const assistantText = pickText(nestedData.text)
            const assistantDelta = pickText(nestedData.delta)
            const assistantThinking = pickText(
              nestedData.thinking,
              nestedData.reasoning,
              nestedData.reasoningContent,
              nestedData.reasoning_content,
              nestedData.thinking_delta,
              nestedData.reasoning_delta
            )
            if (assistantText || assistantDelta || assistantThinking) {
              const content: string | ContentBlock[] = assistantThinking
                ? [
                    { type: 'thinking', thinking: assistantThinking },
                    ...(assistantText || assistantDelta
                      ? [{ type: 'text', text: assistantText ?? assistantDelta ?? '' }]
                      : []),
                  ]
                : (assistantText ?? assistantDelta ?? '')
              handleChatEvent({
                state: 'delta',
                sessionKey:
                  pickText(payload.sessionKey, nestedData.sessionKey, sessionKeyRef.current) || '',
                runId: pickText(payload.runId, nestedData.runId) || nextId('agent'),
                message: { content },
                usage: nestedData.usage ?? payload.usage,
                durationMs: toNumber(nestedData.durationMs ?? payload.durationMs),
                model: pickText(nestedData.model, payload.model),
                provider: pickText(nestedData.provider, payload.provider),
                errorMessage: pickText(nestedData.errorMessage, payload.errorMessage),
              })
            }
          }

          // lifecycle end 作为流式收尾兜底，避免只剩“停止中”状态
          if (agentStream === 'lifecycle' && pickText(nestedData.phase) === 'end') {
            const lifecycleSessionKey = pickText(payload.sessionKey, nestedData.sessionKey)
            const isVisibleLifecycleSession =
              !lifecycleSessionKey || lifecycleSessionKey === sessionKeyRef.current
            const isTrackedLifecycleSession = Boolean(
              lifecycleSessionKey && activeRunSessionKeyRef.current === lifecycleSessionKey
            )
            if (isVisibleLifecycleSession || isTrackedLifecycleSession) {
              currentRunIdRef.current = null
              activeRunSessionKeyRef.current = null
              abortRequestedSessionKeyRef.current = null
            }
            if (isVisibleLifecycleSession) {
              setIsStreaming(false)
              updateSessionMessages(lifecycleSessionKey || sessionKeyRef.current || '', (prev) =>
                prev.map((m) => (m.streaming ? { ...m, streaming: false } : m))
              )
            }
          }
          if (agentStream === 'lifecycle') {
            const lifecyclePhase = pickText(nestedData.phase)
            const lifecycleSessionKey = pickText(payload.sessionKey, nestedData.sessionKey)
            const lifecycleRunId = pickText(payload.runId, nestedData.runId)
            const isVisibleLifecycleSession =
              !lifecycleSessionKey || lifecycleSessionKey === sessionKeyRef.current
            const visibleHistoryKey =
              lifecycleSessionKey && lifecycleSessionKey === sessionKeyRef.current
                ? lifecycleSessionKey
                : undefined

            if (visibleHistoryKey && (lifecyclePhase === 'start' || lifecyclePhase === 'started')) {
              loadHistoryRef.current?.(visibleHistoryKey, { silent: true, force: true })
              scheduleRefreshSessions(500)
            }

            if (lifecyclePhase === 'error') {
              handleChatEvent({
                state: 'error',
                sessionKey: lifecycleSessionKey || sessionKeyRef.current || '',
                runId: lifecycleRunId || currentRunIdRef.current || nextId('agent-error'),
                message: { content: '' },
                errorMessage:
                  pickText(
                    nestedData.error,
                    nestedData.errorMessage,
                    nestedData.message,
                    payload.error,
                    payload.errorMessage
                  ) || '任务执行失败',
                usage: nestedData.usage ?? payload.usage,
                durationMs: toNumber(nestedData.durationMs ?? payload.durationMs),
                model: pickText(nestedData.model, payload.model),
                provider: pickText(nestedData.provider, payload.provider),
              })
              if (visibleHistoryKey) {
                loadHistoryRef.current?.(visibleHistoryKey, { silent: true, force: true })
                scheduleRefreshSessions(500)
              }
              return
            }

            if (
              (lifecyclePhase === 'aborted' || lifecyclePhase === 'cancelled') &&
              (isVisibleLifecycleSession ||
                Boolean(
                  lifecycleSessionKey && activeRunSessionKeyRef.current === lifecycleSessionKey
                ))
            ) {
              currentRunIdRef.current = null
              activeRunSessionKeyRef.current = null
              abortRequestedSessionKeyRef.current = null
            }
            if (
              (lifecyclePhase === 'aborted' || lifecyclePhase === 'cancelled') &&
              isVisibleLifecycleSession
            ) {
              setIsStreaming(false)
            }
            if (
              visibleHistoryKey &&
              (lifecyclePhase === 'end' ||
                lifecyclePhase === 'aborted' ||
                lifecyclePhase === 'cancelled')
            ) {
              loadHistoryRef.current?.(visibleHistoryKey, { silent: true, force: true })
              scheduleRefreshSessions(500)
            }
          }

          const nestedDataMessage =
            nestedData.message && typeof nestedData.message === 'object'
              ? (nestedData.message as RealtimeMessagePayload)
              : undefined
          const nestedDataDirect = nestedData as unknown as RealtimeMessagePayload
          const candidateFromData = nestedDataMessage || nestedDataDirect
          if (isRealtimeMessageRole(candidateFromData?.role)) {
            handleRealtimeMessageEvent(candidateFromData, payload)
            return
          }

          // 某些 agent 事件通过 stream + data 传输 chat 增量，转成统一 chat-event 处理
          const streamState = pickText(payload.stream, nestedData.stream)
          if (
            streamState === 'delta' ||
            streamState === 'final' ||
            streamState === 'aborted' ||
            streamState === 'error'
          ) {
            const content = nestedData.content ?? nestedData.message ?? payload.data
            handleChatEvent({
              state: streamState,
              sessionKey:
                pickText(payload.sessionKey, nestedData.sessionKey, sessionKeyRef.current) || '',
              runId: pickText(payload.runId, nestedData.runId) || nextId('agent'),
              message: { content: content as string | ContentBlock[] },
              usage: nestedData.usage ?? payload.usage,
              durationMs: toNumber(nestedData.durationMs ?? payload.durationMs),
              model: pickText(nestedData.model, payload.model),
              provider: pickText(nestedData.provider, payload.provider),
              errorMessage: pickText(nestedData.errorMessage, payload.errorMessage),
            })
            return
          }
        }

        const direct = payload as unknown as RealtimeMessagePayload
        const nested = payload.message as RealtimeMessagePayload | undefined
        const candidate = nested && typeof nested === 'object' ? nested : direct
        if (isRealtimeMessageRole(candidate?.role)) {
          handleRealtimeMessageEvent(candidate, payload)
        }
      }
    },
    [
      sendConnectFrame,
      handleChatEvent,
      handleHealthEvent,
      handleRealtimeMessageEvent,
      handleAgentToolEvent,
      handleSessionActivityItems,
      scheduleRefreshSessions,
      updateSessionMessages,
      writeDebugLog,
    ]
  )

  // ========== 连接管理 ==========

  function scheduleReconnect(): void {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    const delay = RECONNECT_DELAYS[Math.min(reconnectCountRef.current, RECONNECT_DELAYS.length - 1)]
    reconnectCountRef.current++
    reconnectTimerRef.current = setTimeout(() => {
      if (!intentionalCloseRef.current) doConnect()
    }, delay)
  }

  const doConnect = useCallback((): void => {
    if (!tokenRef.current) {
      setStatus('disconnected')
      setErrorMsg('Gateway token unavailable')
      return
    }
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.close()
      wsRef.current = null
    }
    stopPing()
    flushPending()
    setStatus('connecting')

    const url = `ws://127.0.0.1:${portRef.current}/ws?token=${encodeURIComponent(tokenRef.current)}`
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      scheduleReconnect()
      return
    }
    wsRef.current = ws

    ws.onopen = () => {
      // 等待 Gateway 发 connect.challenge，5s 内没收到则主动发（空 nonce）
      challengeTimerRef.current = setTimeout(() => {
        if (statusRef.current !== 'ready') {
          void sendConnectFrame('')
        }
      }, CHALLENGE_TIMEOUT_MS)
    }

    ws.onmessage = (evt) => handleMessage(evt.data as string)

    ws.onclose = (e) => {
      wsRef.current = null
      stopPing()
      flushPending()
      if (intentionalCloseRef.current) return

      // 认证失败不重连
      if (e.code === 4001 || e.code === 4003 || e.code === 4004) {
        setStatus('error')
        setErrorMsg('Token 认证失败，请检查配置')
        return
      }

      // 1008 = origin not allowed，自动写入 allowedOrigins 后重连（最多 1 次）
      if (/TOKEN_MISMATCH|token mismatch/i.test(e.reason || '') && retryMismatchRef.current < 1) {
        retryMismatchRef.current++
        setErrorMsg('Gateway token changed, refreshing local device auth...')
        window.api.gateway
          .clearDeviceToken(deviceIdRef.current, 'operator')
          .then(() => loadGatewayAuthContext())
          .finally(() => {
            if (!intentionalCloseRef.current) doConnectRef.current?.()
          })
        return
      }

      if (e.code === 1008 && autoPairAttemptsRef.current < 1) {
        autoPairAttemptsRef.current++
        setErrorMsg('origin not allowed，自动修复中...')
        autoPairAndReconnectRef.current?.()
        return
      }

      setStatus('disconnected')
      scheduleReconnect()
    }

    ws.onerror = () => {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopPing, flushPending, handleMessage, sendConnectFrame, loadGatewayAuthContext])

  /**
   * 自动配对重连：写入 allowedOrigins → 重启 Gateway → 2s 后重连
   */
  const autoPairAndReconnect = useCallback(async (): Promise<void> => {
    try {
      await window.api.gateway.autoPairDevice()
      await window.api.gateway.restart()
      setTimeout(() => {
        if (!intentionalCloseRef.current) {
          reconnectCountRef.current = 0
          doConnectRef.current?.()
        }
      }, 2000)
    } catch (e) {
      setStatus('error')
      setErrorMsg(`自动配对失败: ${String(e)}`)
    }
  }, []) // 通过 doConnectRef 访问 doConnect，无需直接依赖

  // 保持 ref 与最新函数同步（打破循环依赖）
  useEffect(() => {
    doConnectRef.current = doConnect
  }, [doConnect])
  useEffect(() => {
    autoPairAndReconnectRef.current = autoPairAndReconnect
  }, [autoPairAndReconnect])

  // ========== 初始化连接 ==========

  useEffect(() => {
    let cancelled = false

    const init = async (): Promise<(() => void) | void> => {
      try {
        const port = await window.api.gateway.getPort()
        if (cancelled) return
        portRef.current = port
      } catch {
        if (!cancelled) setStatus('error')
        return
      }

      // 监听 Gateway 状态变化，Gateway 启动后自动连接
      const offStateChange = window.api.gateway.onStateChange((gwState) => {
        if (cancelled) return
        if (gwState === 'running') {
          setGatewayRunning(true)
          Promise.all([window.api.gateway.getPort(), loadGatewayAuthContext()])
            .then(([port]) => {
              if (!cancelled) {
                portRef.current = port
                intentionalCloseRef.current = false
                reconnectCountRef.current = 0
                doConnect()
              }
            })
            .catch(() => {
              if (!cancelled) {
                setStatus('error')
                setErrorMsg('Failed to initialize gateway connection context')
              }
            })
        } else if (gwState === 'stopped' || gwState === 'stopping') {
          setGatewayRunning(false)
          intentionalCloseRef.current = true
          wsRef.current?.close()
          setStatus('disconnected')
          setErrorMsg(null)
          setSessionKey(null)
          messagesRef.current = []
          setMessages([])
          setHistoryLoading(false)
          setSessions([])
          messageCacheRef.current.clear()
          tokenRef.current = ''
          deviceIdRef.current = ''
        }
      })

      // 如果 Gateway 已经在运行，直接连接
      const gwState = await window.api.gateway.getState()
      if (cancelled) return
      if (gwState === 'running') {
        setGatewayRunning(true)
        try {
          await loadGatewayAuthContext()
          if (cancelled) return
          if (portRef.current > 0) {
            intentionalCloseRef.current = false
            doConnect()
          }
        } catch {
          if (!cancelled) {
            setStatus('error')
            setErrorMsg('Failed to initialize gateway connection context')
          }
        }
      }

      return offStateChange
    }

    let cleanupStateListener: (() => void) | null = null
    init().then((off) => {
      cleanupStateListener = off || null
    })

    return () => {
      cancelled = true
      cleanupStateListener?.()
      intentionalCloseRef.current = true
      wsRef.current?.close()
      stopPing()
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      if (challengeTimerRef.current) clearTimeout(challengeTimerRef.current)
      if (refreshSessionsTimerRef.current) clearTimeout(refreshSessionsTimerRef.current)
    }
  }, [doConnect, loadGatewayAuthContext, stopPing])

  useEffect(() => {
    if (status !== 'ready') return undefined

    const refreshOnFocus = (): void => {
      if (document.visibilityState === 'hidden') return
      scheduleRefreshSessions(250)
    }

    window.addEventListener('focus', refreshOnFocus)
    document.addEventListener('visibilitychange', refreshOnFocus)

    return () => {
      window.removeEventListener('focus', refreshOnFocus)
      document.removeEventListener('visibilitychange', refreshOnFocus)
    }
  }, [scheduleRefreshSessions, status])

  useEffect(() => {
    return window.api.gateway.onSessionActivityChanged((payload) => {
      if (statusRef.current !== 'ready') return
      const sessions = Array.isArray(payload.sessions) ? payload.sessions : []
      const items = sessions.reduce<SessionItem[]>((result, session) => {
        if (!session || typeof session !== 'object') return result
        const data = session as { key?: unknown; updatedAt?: unknown }
        const key = pickText(data.key)
        if (!key) return result
        result.push({
          key,
          label: parseSessionLabel(key),
          updatedAt: toNumber(data.updatedAt) ?? Date.now(),
        })
        return result
      }, [])
      handleSessionActivityItems(items)
    })
  }, [handleSessionActivityItems])

  useEffect(() => {
    return window.api.gateway.onLog((line) => {
      if (statusRef.current !== 'ready') return
      const match = line.match(/dispatching to agent \(session=([^)]+)\)/)
      const key = match?.[1]?.trim()
      if (!key) return
      handleSessionActivityItems([
        {
          key,
          label: parseSessionLabel(key),
          updatedAt: Date.now(),
        },
      ])
    })
  }, [handleSessionActivityItems])

  // ========== 公开 API ==========

  const sendMessage = useCallback(
    (text: string, attachments?: AttachmentPayload[]): boolean => {
      const currentKey = sessionKeyRef.current
      if (!currentKey || statusRef.current !== 'ready') {
        writeDebugLog('chat.send rejected before append', {
          sessionKey: currentKey,
          status: statusRef.current,
        })
        return false
      }

      let key = currentKey
      if (isDraftSessionKey(currentKey)) {
        const draft = draftSessionsRef.current[currentKey]
        if (!draft) {
          writeDebugLog('chat.send rejected: draft session missing', { sessionKey: currentKey })
          return false
        }
        const committedName = buildSessionTitleFromMessage(text, draft.createdAt || Date.now())
        const committedKey = `agent:${draft.agentId}:${committedName}`
        key = committedKey

        // 首次发送时才将草稿会话提交为真实会话
        setDraftSessions((prev) => {
          const next = { ...prev }
          delete next[currentKey]
          return next
        })
        setSessions((prev) => {
          const withoutDraft = prev.filter((s) => s.key !== currentKey)
          if (withoutDraft.find((s) => s.key === committedKey)) return withoutDraft
          return [
            {
              key: committedKey,
              label: committedName,
              updatedAt: Date.now(),
            },
            ...withoutDraft,
          ]
        })

        const cached = messageCacheRef.current.get(currentKey)
        if (cached) {
          messageCacheRef.current.set(committedKey, cached)
          messageCacheRef.current.delete(currentKey)
        }
        setSessionKey(committedKey)
        sessionKeyRef.current = committedKey
        rememberSessionKey(committedKey)
      }

      currentRunIdRef.current = null
      activeRunSessionKeyRef.current = key
      abortRequestedSessionKeyRef.current = null

      // 追加用户消息
      const userMsg: ChatMessage = {
        id: nextId('user'),
        role: 'user',
        content: text,
        timestamp: Date.now(),
        attachments: attachments?.length ? attachments : undefined,
      }
      updateSessionMessages(key, (prev) => [...prev, userMsg])

      const useQuickTextRun = shouldUseQuickTextRun(text, attachments)
      const params: Record<string, unknown> = {
        sessionKey: key,
        message: text,
        deliver: false,
        idempotencyKey: nextId('idem'),
      }
      if (useQuickTextRun) {
        params.modelRun = true
        params.promptMode = 'minimal'
        params.bootstrapContextMode = 'lightweight'
        params.extraSystemPrompt = QUICK_TEXT_SYSTEM_PROMPT
      }
      if (attachments && attachments.length > 0) {
        params.attachments = attachments
      }

      // 立即设置 streaming 状态 + 追加 loading 占位气泡，消除网络延迟空窗期
      const pendingAssistantId = nextId('pending-ai')
      setIsStreaming(true)
      updateSessionMessages(key, (prev) => [
        ...prev,
        {
          id: pendingAssistantId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          streaming: true,
        },
      ])

      rpc(useQuickTextRun ? 'agent' : 'chat.send', params)
        .then((result) => {
          const runId = pickText((result as Record<string, unknown> | undefined)?.runId)
          if (!runId) {
            throw new Error('Gateway did not return runId')
          }
          currentRunIdRef.current = runId
          activeRunSessionKeyRef.current = key
          updateSessionMessages(key, (prev) =>
            prev.map((message) =>
              message.id === pendingAssistantId ? { ...message, id: runId } : message
            )
          )
          if (abortRequestedSessionKeyRef.current === key) {
            abortedRunIdsRef.current.add(runId)
            rpc('chat.abort', { sessionKey: key, runId }).catch(() => {})
          }
        })
        .catch((err) => {
          // RPC 失败时回滚 loading 气泡并重置 isStreaming
          currentRunIdRef.current = null
          activeRunSessionKeyRef.current = null
          abortRequestedSessionKeyRef.current = null
          setIsStreaming(false)
          updateSessionMessages(key, (prev) =>
            prev.filter((m) => !(m.role === 'assistant' && m.streaming))
          )
          console.error('[chat] send failed:', err)
        })
      return true
    },
    [rpc, updateSessionMessages, writeDebugLog]
  )

  const abortMessage = useCallback((): void => {
    const key = activeRunSessionKeyRef.current || sessionKeyRef.current
    if (!key) return
    const runId = currentRunIdRef.current
    if (runId) abortedRunIdsRef.current.add(runId)
    abortRequestedSessionKeyRef.current = key
    currentRunIdRef.current = null
    activeRunSessionKeyRef.current = null
    setIsStreaming(false)
    markStreamingInterrupted(key)

    const params = runId ? { sessionKey: key, runId } : { sessionKey: key }
    rpc('chat.abort', params).catch((err) => {
      writeDebugLog('chat.abort failed', { error: err.message, params })
    })
  }, [markStreamingInterrupted, rpc, writeDebugLog])

  const reconnect = useCallback((): void => {
    intentionalCloseRef.current = false
    reconnectCountRef.current = 0
    // 用户主动重连时重置修复计数，允许再次自动修复
    autoPairAttemptsRef.current = 0
    retryMismatchRef.current = 0
    doConnect()
  }, [doConnect])

  const switchSession = useCallback(
    (key: string): void => {
      if (key === sessionKeyRef.current) return
      setSessionKey(key)
      sessionKeyRef.current = key
      rememberSessionKey(key)
      const cached = messageCacheRef.current.get(key)
      const targetIsStreaming =
        activeRunSessionKeyRef.current === key || Boolean(cached?.some((m) => m.streaming))
      setIsStreaming(targetIsStreaming)
      if (cached) {
        messagesRef.current = cached
        setMessages(cached)
      } else if (isDraftSessionKey(key)) {
        messagesRef.current = []
        setMessages([])
      } else {
        messagesRef.current = []
        setMessages([])
      }
      if (isDraftSessionKey(key)) {
        setHistoryLoading(false)
        return
      }
      loadHistory(key)
    },
    [loadHistory]
  )

  const newSession = useCallback(
    (name: string, agentId?: string): void => {
      const key = sessionKeyRef.current
      // 用传入的 agentId，或从当前 sessionKey 解析（格式：agent:<agentId>:<channelName>）
      const resolvedAgentId = agentId || parseAgentIdFromSessionKey(key) || defaultAgentId || 'main'
      const newKey = buildDraftSessionKey(name)
      const createdAt = Date.now()
      const nextDraftSessions = {
        ...draftSessionsRef.current,
        [newKey]: { name, agentId: resolvedAgentId, createdAt },
      }
      draftSessionsRef.current = nextDraftSessions
      setDraftSessions(nextDraftSessions)
      // 立即在会话列表插入虚拟条目，无需等待发送消息后 Gateway 才更新列表
      setSessions((prev) => {
        if (prev.find((s) => s.key === newKey)) return prev
        return [{ key: newKey, label: name, updatedAt: createdAt }, ...prev]
      })
      switchSession(newKey)
    },
    [defaultAgentId, switchSession]
  )

  const setDraftAgent = useCallback((agentId: string): void => {
    const key = sessionKeyRef.current
    if (!key || !isDraftSessionKey(key)) return
    const normalized = agentId.trim()
    if (!normalized) return
    const draft = draftSessionsRef.current[key]
    if (!draft) return
    const nextDraftSessions = {
      ...draftSessionsRef.current,
      [key]: { ...draft, agentId: normalized },
    }
    draftSessionsRef.current = nextDraftSessions
    setDraftSessions(nextDraftSessions)
  }, [])

  const deleteSession = useCallback(
    (key: string): Promise<void> => {
      if (isDraftSessionKey(key)) {
        const nextDraftSessions = { ...draftSessionsRef.current }
        delete nextDraftSessions[key]
        draftSessionsRef.current = nextDraftSessions
        setDraftSessions(nextDraftSessions)
        setSessions((prev) => prev.filter((s) => s.key !== key))
        if (key === sessionKeyRef.current) {
          const mainKey = mainSessionKeyRef.current
          if (mainKey) switchSession(mainKey)
          else {
            setSessionKey(null)
            sessionKeyRef.current = null
            messagesRef.current = []
            setMessages([])
          }
        }
        messageCacheRef.current.delete(key)
        return Promise.resolve()
      }

      const mainKey = mainSessionKeyRef.current
      // 主会话不允许删除
      if (key === mainKey) return Promise.reject(new Error('main'))

      // 乐观更新：立即从列表移除，立即切换到主会话
      setSessions((prev) => prev.filter((s) => s.key !== key))
      if (key === sessionKeyRef.current) {
        switchSession(mainKey || key)
      }

      // 后台发送 RPC，失败时刷新列表回滚
      return (rpc('sessions.delete', { key }) as Promise<void>).catch((err) => {
        scheduleRefreshSessions(500)
        throw err
      })
    },
    [rpc, switchSession, scheduleRefreshSessions]
  )

  const resetSession = useCallback(
    (targetKey?: string): Promise<void> => {
      const key = targetKey || sessionKeyRef.current
      if (!key) return Promise.resolve()

      if (isDraftSessionKey(key)) {
        messageCacheRef.current.set(key, [])
        if (key === sessionKeyRef.current) {
          messagesRef.current = []
          setMessages([])
        }
        return Promise.resolve()
      }

      // 乐观更新：重置当前会话时立即清空消息
      if (key === sessionKeyRef.current) {
        messageCacheRef.current.set(key, [])
        messagesRef.current = []
        setMessages([])
      }

      return rpc('sessions.reset', { key }) as Promise<void>
    },
    [rpc]
  )

  /** 通过 WS RPC 获取运行时 Agent 列表（含隐式 main），WS 未就绪时返回 null */
  const listAgents = useCallback((): Promise<AgentsListResult | null> => {
    if (status !== 'ready') return Promise.resolve(null)
    return rpc('agents.list', {}) as Promise<AgentsListResult>
  }, [status, rpc])

  const callRpc = useCallback(
    (method: string, params: unknown): Promise<unknown> => {
      if (statusRef.current !== 'ready') return Promise.reject(new Error('WebSocket not ready'))
      return rpc(method, params)
    },
    [rpc]
  )

  const isDraftSession = isDraftSessionKey(sessionKey)
  const currentSessionAgentId = isDraftSession
    ? (sessionKey ? draftSessions[sessionKey]?.agentId : undefined) || defaultAgentId
    : parseAgentIdFromSessionKey(sessionKey) || defaultAgentId

  return {
    status,
    sessionKey,
    errorMsg,
    messages,
    historyLoading,
    gatewayRunning,
    isStreaming,
    sessions,
    defaultAgentId,
    isDraftSession,
    currentSessionAgentId,
    sendMessage,
    abortMessage,
    newSession,
    setDraftAgent,
    reconnect,
    switchSession,
    deleteSession,
    resetSession,
    refreshSessions,
    listAgents,
    callRpc,
  }
}
