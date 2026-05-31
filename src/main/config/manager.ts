/**
 * 配置管理器 — JSON5 读写 ~/.openclaw/openclaw.json
 *
 * 核心职责：
 * 1. 读取配置文件（JSON5 格式，支持注释和尾逗号）
 * 2. 写入配置文件（写前自动备份）
 * 3. 部分更新（deep merge，不丢失用户手动添加的字段）
 * 4. 配置健康检查（JSON 可解析性验证）
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join } from 'path'
import JSON5 from 'json5'
import {
  CONFIG_PATH,
  BACKUP_DIR,
  IS_MAC,
  IS_WIN,
  OPENCLAW_HOME,
  YUTIANCLAW_GATEWAY_DIR,
  isPackaged,
  resolveBundledGatewayDir,
  resolveBundledNodeBin,
} from '../constants'
import { createLogger } from '../logger'
import { createSnapshot, validateConfigContent } from './backup'
import type { SnapshotSource } from './backup'
import { normalizeModelBaseUrlForRuntime } from './model-base-url'

const log = createLogger('config')
const YUTIAN_MODEL_BASE_URL = 'https://claw.yutianedu.com/v1'
const YUTIAN_MODEL_ID = 'DeepSeek-V4-Pro'
const YUTIAN_MODEL_NAME = '誉天大模型'
const YUTIAN_MODEL_INPUT = ['text', 'image']
const DEFAULT_LLM_TIMEOUT_SECONDS = 180
const YUTIAN_MODEL_TIMEOUT_SECONDS = DEFAULT_LLM_TIMEOUT_SECONDS
const YUTIAN_PROVIDER_KEY = 'yutian-ai'
const UNSUPPORTED_LEGACY_MODEL_PREFIXES = ['openai-codex/']
const STALE_LEGACY_PROVIDER_KEYS = new Set(['minimax-portal'])
const STALE_LEGACY_API_KEYS = new Set(['', 'minimax-oauth', 'minimax-portal-auth', 'minimax-auth'])
const STALE_LEGACY_AUTH_PROFILE_PROVIDERS = new Set(['minimax-portal', 'openai-codex'])
const STALE_LEGACY_PLUGIN_KEYS = new Set(['minimax-portal-auth'])
const CHANNEL_PLUGIN_ENTRY_MAP: Record<string, string> = {
  feishu: 'feishu',
  wecom: 'wecom-openclaw-plugin',
  'openclaw-weixin': 'openclaw-weixin',
  qqbot: 'openclaw-qqbot',
  'dingtalk-connector': 'dingtalk-connector',
}
const CHANNEL_PLUGIN_IDS = new Set(Object.values(CHANNEL_PLUGIN_ENTRY_MAP))
const CORE_PLUGIN_ALLOWLIST = [
  'browser',
  'canvas',
  'device-pair',
  'file-transfer',
  'memory-core',
  'phone-control',
  'talk-voice',
]
const FEISHU_DEFAULT_AGENT_ID = 'feishu'
const FEISHU_DEFAULT_AGENT_NAME = '飞书助手'
const FEISHU_DEFAULT_ACCOUNT_ID = 'default'
const FEISHU_DEFAULT_WORKSPACE = '~/.openclaw/workspace-feishu'
const FEISHU_MEDIA_MAX_MB = 30
const CHANNEL_AGENT_DENY_TOOLS = ['session_status', 'web_fetch', 'web_search']
const CHANNEL_AGENT_LEGACY_AUTO_DENY_TOOLS = [
  'image_generate',
  'video_generate',
  'music_generate',
  'tts',
]
const CHANNEL_AGENT_SKILLS = [
  'browser-automation',
  'feishu-doc',
  'feishu-drive',
  'feishu-perm',
  'feishu-wiki',
  'gsap',
  'hyperframes',
  'hyperframes-cli',
  'hyperframes-registry',
  'hyperframes-video-generator',
  'pdf',
  'website-to-hyperframes',
]
const CHANNEL_AGENT_SKILLS_PROMPT_CHARS = 12000
const CHANNEL_AGENT_BOOTSTRAP_MAX_CHARS = 3000
const CHANNEL_AGENT_BOOTSTRAP_TOTAL_MAX_CHARS = 6000
const DEFAULT_AGENT_SKILLS_PROMPT_CHARS = 12000
const DEFAULT_AGENT_BOOTSTRAP_MAX_CHARS = 3000
const DEFAULT_AGENT_BOOTSTRAP_TOTAL_MAX_CHARS = 8000
const CHROME_DEVTOOLS_MCP_SERVER_NAME = 'chrome-devtools'
const CHROME_DEVTOOLS_MCP_PACKAGE = 'chrome-devtools-mcp'
const CHROME_DEVTOOLS_MCP_BIN_RELATIVE = [
  'node_modules',
  CHROME_DEVTOOLS_MCP_PACKAGE,
  'build',
  'src',
  'bin',
  'chrome-devtools-mcp.js',
]
const FEISHU_AGENT_GUIDANCE_MARKER = '<!-- yutianclaw-feishu-channel-guidance -->'
const FEISHU_AGENT_GUIDANCE = `${FEISHU_AGENT_GUIDANCE_MARKER}
# YuTianClaw Feishu Channel

You are handling messages that arrive from Feishu.

Rules:
- Reply in the user's language.
- If the user writes Chinese or the language is ambiguous, use Simplified
  Chinese for all visible progress notes, tool summaries, and final replies.
- Do not use English planning phrases such as "Let me..." or "Now let me..."
  unless the user explicitly asks for English.
- Do not read, print, extract, or search for OpenClaw/YuTianClaw secrets, API
  keys, appSecret values, tokens, or ~/.openclaw/openclaw.json.
- Do not manually call Feishu APIs or upload files with Feishu credentials.
  The Feishu channel adapter already owns delivery.
- When you create a file that should be sent back to Feishu, include a
  plain-text MEDIA directive on its own line in the final reply:
  MEDIA:C:\\absolute\\path\\to\\file.pdf
- Do not wrap MEDIA lines in Markdown or code blocks.
- For PDF requests, use the built-in pdf skill and attach the generated .pdf
  with MEDIA.
- Keep user-visible replies concise.
`
const USER_FACING_AGENT_GUIDANCE_MARKER = '<!-- yutianclaw-user-facing-guidance -->'
const USER_FACING_AGENT_GUIDANCE = `${USER_FACING_AGENT_GUIDANCE_MARKER}
# YuTianClaw User-Facing Behavior

Rules:
- When the user writes Chinese or the language is unclear, use Simplified
  Chinese for all user-visible replies, progress notes, tool summaries, and
  final answers.
- Do not use English planning phrases such as "Let me..." or "Now let me..."
  unless the user explicitly asks for English.
- Do not ask the user to name you or repeat first-run identity onboarding.
  Present yourself as the configured YuTianClaw digital employee and start
  solving the request directly.
- Keep code, commands, file paths, API names, model IDs, and quoted source text
  unchanged.
`
const CONFIG_SAFETY_GUIDANCE_MARKER = '<!-- yutianclaw-config-safety-v1 -->'
const CONFIG_SAFETY_GUIDANCE = `${CONFIG_SAFETY_GUIDANCE_MARKER}
# YuTianClaw Config Safety

Rules:
- Do not directly edit ~/.openclaw/openclaw.json, especially models, tools,
  plugins, channels, bindings, and mcp.servers.
- Do not create or modify MCP server entries by writing JSON manually. Ask the
  user to configure MCP from the YuTianClaw UI or an approved installer flow.
- If configuration appears broken, report the problem and let YuTianClaw repair
  or restore it instead of rewriting the file yourself.
`
const YUTIAN_BOOTSTRAP_MARKER = '<!-- yutianclaw-bootstrap-ready -->'
const YUTIAN_BOOTSTRAP_GUIDANCE = `${YUTIAN_BOOTSTRAP_MARKER}
# YuTianClaw Bootstrap

YuTianClaw has already configured the assistant identity and workspace defaults.
Do not run first-time identity onboarding. Start solving the user's request
directly, and use Simplified Chinese when the user's language is unclear.
`
const WORKSPACE_FILE_DEFAULTS = [
  {
    file: 'BOOTSTRAP.md',
    marker: YUTIAN_BOOTSTRAP_MARKER,
    defaultMarkers: ['BOOTSTRAP.md - Hello, World', 'You just woke up'],
    content: YUTIAN_BOOTSTRAP_GUIDANCE,
  },
  {
    file: 'SOUL.md',
    marker: '<!-- yutianclaw-soul-ready -->',
    defaultMarkers: ["You're not a chatbot", 'SOUL.md - Who You Are'],
    content: `<!-- yutianclaw-soul-ready -->
# YuTianClaw Assistant

You are a YuTianClaw digital employee for education and training workflows.
Be concise, practical, and task-oriented. Use Simplified Chinese by default,
unless the user explicitly asks for another language.
`,
  },
  {
    file: 'IDENTITY.md',
    marker: '<!-- yutianclaw-identity-ready -->',
    defaultMarkers: ['IDENTITY.md - Who Am I?', 'pick something you like'],
    content: `<!-- yutianclaw-identity-ready -->
# Identity

- Name: 小誉
- Role: YuTianClaw 教育行业 AI 数字员工
- Style: 专业、直接、可靠，优先完成用户任务
`,
  },
  {
    file: 'USER.md',
    marker: '<!-- yutianclaw-user-ready -->',
    defaultMarkers: ['USER.md - About Your Human', "Learn about the person you're helping"],
    content: `<!-- yutianclaw-user-ready -->
# User Context

The user is working in YuTianClaw. Help with teaching materials, PDF files,
Feishu messages, local files, MCP tools, and workflow execution.
`,
  },
  {
    file: 'TOOLS.md',
    marker: '<!-- yutianclaw-tools-ready -->',
    defaultMarkers: ['TOOLS.md - Local Notes', 'Things like:'],
    content: `<!-- yutianclaw-tools-ready -->
# Tools

Use YuTianClaw bundled skills, MCP tools, local file operations, and channel
delivery features when they directly help complete the user's request.
`,
  },
  {
    file: 'HEARTBEAT.md',
    marker: '<!-- yutianclaw-heartbeat-ready -->',
    defaultMarkers: ['Keep this file empty', 'Heartbeat config'],
    content: `<!-- yutianclaw-heartbeat-ready -->
# Heartbeat

No scheduled heartbeat tasks.
`,
  },
] as const

// ========== 类型定义 ==========

/**
 * YuTianClaw 关注的配置子集
 * OpenClaw 配置字段非常多，我们只操作需要的部分，其余透传保留
 */
export interface OpenclawConfig {
  /** 模型/Provider 配置 */
  models?: {
    providers?: Record<string, ProviderConfig>
  }

  skills?: Record<string, unknown>

  /** Agent 配置 */
  agents?: {
    defaults?: {
      model?: string | { primary: string; fallbacks?: string[] }
      models?: Record<string, { alias?: string; params?: Record<string, unknown> }>
      workspace?: string
      [key: string]: unknown
    }
    list?: AgentConfig[]
  }

  /** 渠道配置 */
  channels?: {
    telegram?: Record<string, unknown>
    feishu?: Record<string, unknown>
    discord?: Record<string, unknown>
    bluebubbles?: Record<string, unknown>
    slack?: Record<string, unknown>
    whatsapp?: Record<string, unknown>
    defaults?: Record<string, unknown>
    [key: string]: unknown
  }

  /** 路由绑定 */
  bindings?: Array<{
    agentId: string
    match: Record<string, unknown>
    [key: string]: unknown
  }>

  /** Gateway 配置 */
  gateway?: {
    port?: number
    bind?: string
    mode?: string
    [key: string]: unknown
  }

  /** 命令配置 */
  commands?: Record<string, unknown>

  /** 工具配置 */
  tools?: Record<string, unknown>

  /** 会话路由配置 */
  session?: Record<string, unknown>

  /** 插件配置 */
  plugins?: {
    allow?: string[]
    bundledDiscovery?: string
    entries?: Record<string, { enabled?: boolean; [key: string]: unknown }>
    installs?: Record<string, Record<string, unknown>>
    [key: string]: unknown
  }

  /** 透传字段 */
  [key: string]: unknown
  /** MCP server registry */
  mcp?: {
    servers?: Record<string, Record<string, unknown>>
    [key: string]: unknown
  }
}

export interface ProviderConfig {
  apiKey?: string
  baseUrl?: string
  api?: 'anthropic-messages' | 'openai-completions' | 'openai-responses'
  models?: Array<{
    id: string
    name?: string
    input?: string[]
  }>
  [key: string]: unknown
}

export interface AgentConfig {
  id: string
  default?: boolean
  name?: string
  workspace?: string
  model?: string | { primary: string; fallbacks?: string[] }
  identity?: {
    name?: string
    theme?: string
    emoji?: string
    [key: string]: unknown
  }
  groupChat?: Record<string, unknown>
  sandbox?: Record<string, unknown>
  tools?: Record<string, unknown>
  [key: string]: unknown
}

// ========== 配置健康检查 ==========

export interface ConfigHealth {
  exists: boolean
  parseable: boolean
  error?: string
  raw?: string
}

/**
 * 检查配置文件健康状态（不修改任何文件）
 */
export interface McpCompatibilityRepairResult {
  changed: boolean
  migrated: string[]
  skipped: string[]
  ensured: string[]
  quarantined: string[]
  removedLegacyKeys: string[]
}

export function inspectConfigHealth(): ConfigHealth {
  if (!existsSync(CONFIG_PATH)) {
    return { exists: false, parseable: false }
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    JSON5.parse(raw)
    return { exists: true, parseable: true, raw }
  } catch (err) {
    return {
      exists: true,
      parseable: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ========== 读取配置 ==========

/**
 * 读取配置文件，返回解析后的对象
 * 文件不存在或解析失败时返回空对象 {}
 */
export function readConfig(): OpenclawConfig {
  if (!existsSync(CONFIG_PATH)) {
    log.debug('config file not found, returning empty config')
    return {}
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    const config = JSON5.parse(raw) as OpenclawConfig
    log.debug('config loaded successfully')
    return config
  } catch (err) {
    log.error('failed to parse config:', err)
    return {}
  }
}

/**
 * 读取配置文件的原始 JSON5 文本
 * 用于备份和健康检查
 */
export function readConfigRaw(): string | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8')
    // 验证可解析性
    JSON5.parse(raw)
    return raw
  } catch {
    return null
  }
}

// ========== 写入配置 ==========

/**
 * 写入完整配置
 * @param config 完整配置对象
 * @param options 快照选项（来源和摘要，用于智能快照）
 */
export function writeConfig(
  config: OpenclawConfig,
  options?: { source?: SnapshotSource; summary?: string; skipSnapshot?: boolean }
): void {
  // 确保目录存在
  if (!existsSync(OPENCLAW_HOME)) {
    mkdirSync(OPENCLAW_HOME, { recursive: true })
  }

  // 写前快照
  if (!options?.skipSnapshot && existsSync(CONFIG_PATH)) {
    try {
      createSnapshot(options?.source || 'auto', options?.summary || '配置更新')
    } catch (err) {
      log.warn('snapshot before write failed:', err)
    }
  }

  // 写前验证
  const content = JSON5.stringify(config, null, 2) + '\n'
  const validation = validateConfigContent(content)
  if (!validation.valid) {
    throw new Error(`config validation failed: ${validation.error}`)
  }

  writeFileSync(CONFIG_PATH, content, 'utf-8')

  // 写后验证（读回检查）
  try {
    const readBack = readFileSync(CONFIG_PATH, 'utf-8')
    JSON5.parse(readBack)
  } catch (err) {
    log.error('post-write validation failed:', err)
    throw new Error('config written but post-write validation failed')
  }

  log.info('config written successfully')
}

// ========== 部分更新 ==========

/**
 * 部分更新配置（deep merge）
 * 只修改指定的字段，保留其余所有字段
 */
export function updateConfig(partial: Partial<OpenclawConfig>): OpenclawConfig {
  const current = readConfig()
  const merged = deepMerge(current, partial) as OpenclawConfig
  writeConfig(merged)
  return merged
}

/**
 * 设置指定路径的配置值
 * 例如：setConfigValue('agents.defaults.model', 'anthropic/claude-opus-4-6')
 */
export function setConfigValue(path: string, value: unknown): void {
  const config = readConfig()
  setNestedValue(config, path, value)
  writeConfig(config)
}

/**
 * 删除指定路径的配置值
 */
export function deleteConfigValue(path: string): void {
  const config = readConfig()
  deleteNestedValue(config, path)
  writeConfig(config)
}

/**
 * 获取指定路径的配置值
 */
export function getConfigValue(path: string): unknown {
  const config = readConfig()
  return getNestedValue(config, path)
}

// ========== Provider 快捷操作 ==========

/**
 * 设置 Provider 配置
 */
export function setProvider(name: string, provider: ProviderConfig): void {
  const config = readConfig()
  if (!config.models) config.models = {}
  if (!config.models.providers) config.models.providers = {}
  const normalizedProvider: ProviderConfig = {
    ...provider,
    baseUrl: normalizeModelBaseUrlForRuntime(provider.baseUrl, provider.api),
  }
  ensureProviderTimeout(normalizedProvider)
  config.models.providers[name] = normalizedProvider
  writeConfig(config, { source: 'provider', summary: `配置 Provider: ${name}` })
  log.info(`provider "${name}" configured`)
}

/**
 * 获取所有已配置的 Provider
 */
export function getProviders(): Record<string, ProviderConfig> {
  const config = readConfig()
  return config.models?.providers || {}
}

/**
 * 删除指定 Provider
 */
export function deleteProvider(name: string): void {
  const config = readConfig()
  if (config.models?.providers) {
    delete config.models.providers[name]
  }
  writeConfig(config, { source: 'provider', summary: `删除 Provider: ${name}` })
  log.info(`provider "${name}" deleted`)
}

// ========== Channel 快捷操作 ==========

/**
 * 设置 Channel 配置
 */
function normalizeChannelConfigForRuntime(
  name: string,
  channelConfig: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...channelConfig }
  if (name === 'feishu') {
    normalizeFeishuChannelDefaults(next)
  }
  return next
}

function normalizeFeishuChannelDefaults(feishu: Record<string, unknown>): void {
  const mediaMaxMb = feishu.mediaMaxMb
  if (
    typeof mediaMaxMb !== 'number' ||
    !Number.isFinite(mediaMaxMb) ||
    mediaMaxMb < FEISHU_MEDIA_MAX_MB
  ) {
    feishu.mediaMaxMb = FEISHU_MEDIA_MAX_MB
  }

  const accounts = isPlainRecord(feishu.accounts) ? feishu.accounts : null
  if (!accounts) return

  for (const account of Object.values(accounts)) {
    if (!isPlainRecord(account)) continue
    const accountMediaMaxMb = account.mediaMaxMb
    if (
      typeof accountMediaMaxMb === 'number' &&
      Number.isFinite(accountMediaMaxMb) &&
      accountMediaMaxMb > 0 &&
      accountMediaMaxMb < FEISHU_MEDIA_MAX_MB
    ) {
      account.mediaMaxMb = FEISHU_MEDIA_MAX_MB
    }
  }
}

export function setChannel(name: string, channelConfig: Record<string, unknown>): void {
  const config = readConfig()
  if (!config.channels) config.channels = {}
  const normalizedChannelConfig = normalizeChannelConfigForRuntime(name, channelConfig)
  config.channels[name] = normalizedChannelConfig
  ensureChannelPluginEntryInConfig(config, name, normalizedChannelConfig)
  writeConfig(config, { source: 'channel', summary: `配置渠道: ${name}` })
  log.info(`channel "${name}" configured`)
}

/**
 * 获取指定 Channel 配置
 */
export function getChannel(name: string): Record<string, unknown> | undefined {
  const config = readConfig()
  return config.channels?.[name] as Record<string, unknown> | undefined
}

/**
 * 获取所有 Channel 配置
 */
export function getChannels(): Record<string, Record<string, unknown>> {
  const config = readConfig()
  if (!config.channels) return {}
  // 过滤掉非渠道字段（如 defaults）
  const result: Record<string, Record<string, unknown>> = {}
  for (const [key, value] of Object.entries(config.channels)) {
    if (key === 'whatsapp') continue
    if (key !== 'defaults' && typeof value === 'object' && value !== null) {
      result[key] = value as Record<string, unknown>
    }
  }
  return result
}

/**
 * 删除指定 Channel 配置
 */
export function deleteChannel(name: string): void {
  const config = readConfig()
  if (config.channels) {
    delete config.channels[name]
  }
  writeConfig(config, { source: 'channel', summary: `删除渠道: ${name}` })
  log.info(`channel "${name}" deleted`)
}

/**
 * 保存渠道账户凭证（多账户模式）
 * 写入 channels.<channelKey>.accounts.<accountId>
 * 首个账户自动设为 defaultAccount
 */
export function saveChannelAccount(
  channelKey: string,
  accountId: string,
  accountData: Record<string, unknown>
): void {
  const config = readConfig()
  if (!config.channels) config.channels = {}
  if (!config.channels[channelKey]) config.channels[channelKey] = {}
  const ch = config.channels[channelKey] as Record<string, unknown>
  if (!ch.accounts) ch.accounts = {}
  ;(ch.accounts as Record<string, unknown>)[accountId] = accountData
  if (channelKey === 'feishu') {
    normalizeFeishuChannelDefaults(ch)
  }
  // 首个账户自动成为默认账户
  if (!ch.defaultAccount) ch.defaultAccount = accountId
  ensureChannelPluginEntryInConfig(config, channelKey, ch)
  writeConfig(config, { source: 'channel', summary: `保存渠道账户: ${channelKey}/${accountId}` })
  log.info(`channel account "${channelKey}/${accountId}" saved`)
}

/**
 * 删除渠道账户
 * 若删除的是 defaultAccount，自动切换到第一个剩余账户
 */
export function deleteChannelAccount(channelKey: string, accountId: string): void {
  const config = readConfig()
  const ch = config.channels?.[channelKey] as Record<string, unknown> | undefined
  if (!ch) return
  const accounts = ch.accounts as Record<string, unknown> | undefined
  if (accounts) {
    delete accounts[accountId]
    // 若删除的是默认账户，自动切换
    if (ch.defaultAccount === accountId) {
      const remaining = Object.keys(accounts)
      ch.defaultAccount = remaining.length > 0 ? remaining[0] : undefined
    }
  }
  writeConfig(config, { source: 'channel', summary: `删除渠道账户: ${channelKey}/${accountId}` })
  log.info(`channel account "${channelKey}/${accountId}" deleted`)
}

/**
 * 设置渠道默认账户
 */
export function setChannelDefaultAccount(channelKey: string, accountId: string): void {
  const config = readConfig()
  const ch = config.channels?.[channelKey] as Record<string, unknown> | undefined
  if (!ch) return
  ch.defaultAccount = accountId
  ensureChannelPluginEntryInConfig(config, channelKey, ch)
  writeConfig(config, { source: 'channel', summary: `设置默认账户: ${channelKey}/${accountId}` })
  log.info(`channel "${channelKey}" default account set to "${accountId}"`)
}

// ========== Agent 快捷操作 ==========

const SNAPSHOT_FILE_RE = /\.snapshot\.json$/i
const AGENT_RECOVERY_SKIP_SUMMARY_RE = /删除\s*Agent|delete\s+agent|remove\s+agent/i

function normalizeAgentConfigId(agentId?: string): string {
  return (agentId || '').trim().toLowerCase()
}

function isUserAgent(agent: AgentConfig | undefined): boolean {
  const id = normalizeAgentConfigId(agent?.id)
  return Boolean(id && id !== 'main')
}

function hasUserAgents(list: AgentConfig[]): boolean {
  return list.some(isUserAgent)
}

function mergeAgentLists(base: AgentConfig[], additions: AgentConfig[]): AgentConfig[] {
  const merged: AgentConfig[] = []
  const seen = new Set<string>()

  for (const agent of [...base, ...additions]) {
    const id = normalizeAgentConfigId(agent.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    merged.push(agent)
  }

  return merged
}

function readSnapshotAgentList(filePath: string): AgentConfig[] {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const snapshot = JSON.parse(raw) as {
      meta?: { summary?: string }
      config?: { agents?: { list?: unknown[] } }
    }
    const summary = snapshot.meta?.summary || ''
    if (AGENT_RECOVERY_SKIP_SUMMARY_RE.test(summary)) return []

    const list = snapshot.config?.agents?.list
    if (!Array.isArray(list)) return []

    return list.filter((item): item is AgentConfig =>
      Boolean(item && typeof item === 'object' && typeof (item as AgentConfig).id === 'string')
    )
  } catch {
    return []
  }
}

function loadRecoverableAgentsFromBackups(current: AgentConfig[]): AgentConfig[] {
  if (hasUserAgents(current) || !existsSync(BACKUP_DIR)) return []

  try {
    const files = readdirSync(BACKUP_DIR)
      .filter((file) => SNAPSHOT_FILE_RE.test(file))
      .map((file) => {
        const fullPath = join(BACKUP_DIR, file)
        return { file, fullPath, mtimeMs: statSync(fullPath).mtimeMs }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)

    for (const item of files) {
      const agents = readSnapshotAgentList(item.fullPath)
      if (hasUserAgents(agents)) return agents
    }
  } catch (err) {
    log.warn(
      `agent recovery from backups failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  return []
}

function recoverAgentListFromBackups(current: AgentConfig[]): AgentConfig[] {
  const recovered = loadRecoverableAgentsFromBackups(current)
  if (recovered.length === 0) return current
  return mergeAgentLists(current, recovered)
}

export function ensureAgentsRecoveredFromBackups(): void {
  const config = readConfig()
  const current = config.agents?.list ?? []
  const recovered = recoverAgentListFromBackups(current)
  if (recovered.length === current.length) return

  if (!config.agents) config.agents = {}
  config.agents.list = recovered
  writeConfig(config, {
    source: 'auto',
    summary: 'Restore missing digital employees from config backup',
  })
  log.info(`restored ${recovered.length - current.length} missing agents from config backups`)
}

/**
 * 获取 Agent 列表
 */
export function getAgents(): AgentConfig[] {
  const config = readConfig()
  return recoverAgentListFromBackups(config.agents?.list || [])
}

/**
 * 保存 Agent（新增或更新）
 * - id 存在且匹配已有 Agent → 更新
 * - 否则 → 追加（生成新 id）
 */
export function saveAgent(agent: Omit<AgentConfig, 'id'> & { id?: string }): AgentConfig {
  const config = readConfig()
  if (!config.agents) config.agents = {}
  const list = config.agents.list ?? []

  let saved: AgentConfig
  const existingIdx = agent.id ? list.findIndex((a) => a.id === agent.id) : -1

  if (existingIdx >= 0) {
    // 更新已有
    list[existingIdx] = { ...list[existingIdx], ...agent } as AgentConfig
    saved = list[existingIdx]
  } else {
    // 新增：优先使用传入的 id，无 id 时才生成一个
    const newId = agent.id || `agent-${Date.now()}`
    saved = { ...agent, id: newId } as AgentConfig
    list.push(saved)
  }

  config.agents.list = list
  writeConfig(config, { source: 'agent', summary: `保存 Agent: ${saved.name || saved.id}` })
  return saved
}

/**
 * 删除 Agent
 */
export function deleteAgent(agentId: string): void {
  const config = readConfig()
  if (!config.agents?.list) return
  config.agents.list = config.agents.list.filter((a) => a.id !== agentId)
  writeConfig(config, { source: 'agent', summary: `删除 Agent: ${agentId}` })
}

/**
 * 设置默认 Agent
 * 将指定 Agent 的 default 设为 true，其余设为 false
 */
export function setDefaultAgent(agentId: string): void {
  const config = readConfig()
  if (!config.agents?.list) return
  config.agents.list = config.agents.list.map((a) => ({
    ...a,
    default: a.id === agentId,
  }))
  writeConfig(config, { source: 'agent', summary: `设置默认 Agent: ${agentId}` })
}

// ========== Binding 快捷操作 ==========

export interface BindingConfig {
  agentId: string
  match: { channel: string; accountId?: string; [key: string]: unknown }
  [key: string]: unknown
}

export interface BindingRouteRule extends BindingConfig {
  id: string
  type?: 'route'
  priority?: number
}

function isRouteBinding(binding: Record<string, unknown> | undefined): boolean {
  if (!binding || typeof binding !== 'object') return false
  const rawType = typeof binding.type === 'string' ? binding.type.trim().toLowerCase() : ''
  return rawType === '' || rawType === 'route'
}

function normalizeRoles(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const roles = input.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
  if (roles.length === 0) return undefined
  return Array.from(new Set(roles)).sort((a, b) => a.localeCompare(b))
}

function normalizeMatch(matchRaw: Record<string, unknown> | undefined): BindingConfig['match'] {
  const match = matchRaw || {}
  const channel = typeof match.channel === 'string' ? match.channel.trim() : ''
  const accountId = typeof match.accountId === 'string' ? match.accountId.trim() : ''
  const guildId = typeof match.guildId === 'string' ? match.guildId.trim() : ''
  const teamId = typeof match.teamId === 'string' ? match.teamId.trim() : ''
  const roles = normalizeRoles(match.roles)
  const peerRaw = (match.peer || {}) as Record<string, unknown>
  const peerKind = typeof peerRaw.kind === 'string' ? peerRaw.kind.trim().toLowerCase() : ''
  const peerId = typeof peerRaw.id === 'string' ? peerRaw.id.trim() : ''
  const next: BindingConfig['match'] = {
    channel,
  }
  if (accountId) next.accountId = accountId
  if (guildId) next.guildId = guildId
  if (teamId) next.teamId = teamId
  if (roles) next.roles = roles
  if (peerKind && peerId && ['direct', 'group', 'channel', 'dm'].includes(peerKind)) {
    next.peer = { kind: peerKind, id: peerId }
  }
  return next
}

function buildBindingIdentityKey(agentId: string, match: Record<string, unknown>): string {
  const peerRaw = (match.peer || {}) as Record<string, unknown>
  const peerKind = typeof peerRaw.kind === 'string' ? peerRaw.kind.trim().toLowerCase() : ''
  const peerId = typeof peerRaw.id === 'string' ? peerRaw.id.trim() : ''
  const roles = normalizeRoles(match.roles)?.join(',') || ''
  const channel = typeof match.channel === 'string' ? match.channel.trim().toLowerCase() : ''
  const accountId = typeof match.accountId === 'string' ? match.accountId.trim() : ''
  const guildId = typeof match.guildId === 'string' ? match.guildId.trim() : ''
  const teamId = typeof match.teamId === 'string' ? match.teamId.trim() : ''
  const normalizedAgentId = agentId.trim().toLowerCase()
  return [normalizedAgentId, channel, accountId, peerKind, peerId, guildId, teamId, roles].join('|')
}

function computeRouteUiId(binding: BindingConfig, index: number): string {
  const base = `${binding.agentId}|${buildBindingIdentityKey(binding.agentId, binding.match || {})}`
  const encoded = Buffer.from(base).toString('base64url').slice(0, 12)
  return `bind_${index}_${encoded}`
}

function toRouteRule(binding: BindingConfig, index: number): BindingRouteRule {
  const raw = binding as BindingRouteRule
  const id =
    typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : computeRouteUiId(binding, index)
  const priority = Number.isFinite(raw.priority) ? Number(raw.priority) : index
  return {
    ...sanitizeRouteBinding(binding),
    type: 'route',
    id,
    priority,
  }
}

function sanitizeRouteBinding(binding: BindingConfig): BindingConfig {
  const agentId = typeof binding.agentId === 'string' ? binding.agentId.trim() : ''
  const rawType = typeof binding.type === 'string' ? binding.type.trim().toLowerCase() : ''
  const comment =
    typeof binding.comment === 'string' && binding.comment.trim() ? binding.comment.trim() : ''
  const next: BindingConfig = {
    ...(rawType === 'route' ? { type: 'route' } : {}),
    agentId,
    match: normalizeMatch((binding.match || {}) as Record<string, unknown>),
  }
  if (comment) next.comment = comment
  return next
}

/**
 * 获取所有 binding 配置
 */
export function getBindings(): BindingConfig[] {
  const config = readConfig()
  return (config.bindings as BindingConfig[] | undefined) || []
}

/**
 * 列出 route 规则（用于高级路由编辑）
 */
export function listBindingRules(): BindingRouteRule[] {
  const bindings = getBindings()
  return bindings
    .filter((binding) => isRouteBinding(binding as Record<string, unknown>))
    .map((binding, index) => toRouteRule(binding, index))
}

/**
 * 保存 route 规则
 * - 传入 id：按 id 更新
 * - 不传 id：若 identityKey 命中则覆盖；否则新增
 */
export function saveBindingRule(
  rule: Omit<BindingRouteRule, 'id'> & { id?: string }
): BindingRouteRule {
  const config = readConfig()
  const all = ((config.bindings as BindingConfig[] | undefined) || []).map((item) => ({ ...item }))
  const routeIndexes: number[] = []
  for (let i = 0; i < all.length; i += 1) {
    if (isRouteBinding(all[i] as Record<string, unknown>)) routeIndexes.push(i)
  }
  const routeRules = routeIndexes.map((idx, routeIndex) =>
    toRouteRule(all[idx] as BindingConfig, routeIndex)
  )

  const sanitizedInput = sanitizeRouteBinding({
    ...rule,
    match: { ...(rule.match || {}) },
    agentId: rule.agentId,
  } as BindingConfig)
  const normalizedInput = toRouteRule(sanitizedInput, routeRules.length)
  if (rule.id && rule.id.trim()) normalizedInput.id = rule.id.trim()
  const identityKey = buildBindingIdentityKey(
    normalizedInput.agentId,
    (normalizedInput.match || {}) as Record<string, unknown>
  )

  let targetIndex = -1
  if (rule.id && rule.id.trim()) {
    targetIndex = routeRules.findIndex((item) => item.id === rule.id!.trim())
  }
  if (targetIndex < 0) {
    targetIndex = routeRules.findIndex(
      (item) =>
        buildBindingIdentityKey(item.agentId, (item.match || {}) as Record<string, unknown>) ===
        identityKey
    )
  }

  if (targetIndex >= 0) {
    routeRules[targetIndex] = {
      ...routeRules[targetIndex],
      ...normalizedInput,
      id: routeRules[targetIndex].id,
      type: 'route',
    }
  } else {
    routeRules.push(normalizedInput)
  }

  // 保持非 route 条目原位，仅替换 route 序列
  let routeCursor = 0
  const nextBindings: BindingConfig[] = all.map((item) => {
    if (isRouteBinding(item as Record<string, unknown>)) {
      const nextRule = routeRules[routeCursor]
      routeCursor += 1
      return nextRule ? sanitizeRouteBinding(nextRule) : item
    }
    return item
  })
  if (routeCursor < routeRules.length) {
    nextBindings.push(...routeRules.slice(routeCursor).map((item) => sanitizeRouteBinding(item)))
  }

  config.bindings = nextBindings
  writeConfig(config, {
    source: 'auto',
    summary: `保存路由规则: ${normalizedInput.match.channel || 'unknown'} -> ${normalizedInput.agentId}`,
  })
  return targetIndex >= 0 ? routeRules[targetIndex] : routeRules[routeRules.length - 1]
}

/**
 * 删除 route 规则（按 id）
 */
export function deleteBindingRule(id: string): void {
  const normalizedId = id.trim()
  if (!normalizedId) return
  const config = readConfig()
  const all = (config.bindings as BindingConfig[] | undefined) || []
  const next = all.filter((item) => {
    if (!isRouteBinding(item as Record<string, unknown>)) return true
    const route = toRouteRule(item, 0)
    return route.id !== normalizedId
  })
  config.bindings = next.length > 0 ? next : undefined
  writeConfig(config, { source: 'auto', summary: `删除路由规则: ${normalizedId}` })
}

/**
 * 重排 route 规则顺序（仅 route，非 route 保持原位置）
 */
export function reorderBindingRules(ids: string[]): BindingRouteRule[] {
  const normalizedIds = ids.map((id) => id.trim()).filter(Boolean)
  const config = readConfig()
  const all = ((config.bindings as BindingConfig[] | undefined) || []).map((item) => ({ ...item }))
  const routeRules = all
    .filter((item) => isRouteBinding(item as Record<string, unknown>))
    .map((item, index) => toRouteRule(item, index))
  if (routeRules.length === 0) return []

  const byId = new Map(routeRules.map((item) => [item.id, item] as const))
  const ordered: BindingRouteRule[] = []
  for (const id of normalizedIds) {
    const item = byId.get(id)
    if (!item) continue
    ordered.push(item)
    byId.delete(id)
  }
  for (const item of routeRules) {
    if (byId.has(item.id)) ordered.push(item)
  }

  let cursor = 0
  const nextBindings = all.map((item) => {
    if (!isRouteBinding(item as Record<string, unknown>)) return item
    const nextItem = ordered[cursor]
    cursor += 1
    return nextItem ? sanitizeRouteBinding(nextItem) : item
  })
  config.bindings = nextBindings
  writeConfig(config, { source: 'auto', summary: `重排路由规则: ${ordered.length} 条` })
  return ordered
}

/**
 * 保存或更新 binding（channel + accountId 相同时覆盖）
 */
export function saveBinding(agentId: string, channel: string, accountId: string): void {
  deleteBinding(channel, accountId)
  saveBindingRule({
    type: 'route',
    agentId,
    match: { channel, accountId },
  })
  const accountLabel = accountId || 'default'
  log.info(`binding set: ${channel}/${accountId} → ${agentId}`)
  log.debug(`binding normalized via rule save: ${channel}/${accountLabel} -> ${agentId}`)
}

/**
 * 删除指定 channel + accountId 对应的 binding
 */
export function deleteBinding(channel: string, accountId: string): void {
  const config = readConfig()
  const all = (config.bindings as BindingConfig[] | undefined) || []
  const next = all.filter((item) => {
    if (!isRouteBinding(item as Record<string, unknown>)) return true
    const match = normalizeMatch((item.match || {}) as Record<string, unknown>)
    return !(match.channel === channel && (match.accountId || '') === accountId)
  })
  if (next.length === all.length) return
  config.bindings = next.length > 0 ? next : undefined
  writeConfig(config, { source: 'auto', summary: `删除路由规则: ${channel}/${accountId}` })
  log.info(`binding deleted: ${channel}/${accountId}`)
}

/**
 * 设置默认模型
 */
export function setDefaultModel(model: string): void {
  const config = readConfig()
  if (!config.agents) config.agents = {}
  if (!config.agents.defaults) config.agents.defaults = {}
  config.agents.defaults.model = model
  writeConfig(config, { source: 'agent', summary: `设置默认模型: ${model}` })
  log.info(`default model set to "${model}"`)
}

function isYutianProviderKey(providerKey: string): boolean {
  return providerKey === 'yutian' || providerKey.startsWith('yutian-')
}

function normalizeModelAliasKey(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function getProviderKeyFromModelRef(modelRef: string): string {
  const separator = modelRef.indexOf('/')
  return separator > 0 ? modelRef.slice(0, separator) : ''
}

function isUnsupportedLegacyModelRef(modelRef: string): boolean {
  return UNSUPPORTED_LEGACY_MODEL_PREFIXES.some((prefix) => modelRef.startsWith(prefix))
}

function pickPreferredYutianModelId(models: NonNullable<ProviderConfig['models']>): string {
  void models
  return YUTIAN_MODEL_ID
}

function getYutianProviderModelName(providerKey: string): string {
  void providerKey
  return YUTIAN_MODEL_NAME
}

function getPrimaryModelRef(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!isPlainRecord(value)) return undefined
  return typeof value.primary === 'string' ? value.primary : undefined
}

function isYutianModelRef(value: string | undefined): boolean {
  return Boolean(value && isYutianProviderKey(getProviderKeyFromModelRef(value)))
}

function isConfiguredModelRef(
  providers: Record<string, ProviderConfig>,
  modelRef: string | undefined
): boolean {
  if (!modelRef) return false
  const separator = modelRef.indexOf('/')
  if (separator <= 0) return false
  const providerKey = modelRef.slice(0, separator)
  const modelId = modelRef.slice(separator + 1)
  const provider = providers[providerKey]
  if (!provider || !modelId) return false
  const normalizedModelId = normalizeModelAliasKey(modelId)
  return Boolean(
    provider.models?.some((model) => normalizeModelAliasKey(model.id) === normalizedModelId)
  )
}

function isStaleLegacyProvider(providerKey: string, provider: ProviderConfig): boolean {
  if (!STALE_LEGACY_PROVIDER_KEYS.has(providerKey)) return false
  const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim().toLowerCase() : ''
  return STALE_LEGACY_API_KEYS.has(apiKey)
}

function removeDefaultModelRefsForProvider(config: OpenclawConfig, providerKey: string): void {
  const defaultModels = config.agents?.defaults?.models
  if (defaultModels) {
    for (const modelRef of Object.keys(defaultModels)) {
      if (getProviderKeyFromModelRef(modelRef) === providerKey) {
        delete defaultModels[modelRef]
      }
    }
  }

  const currentPrimary = getPrimaryModelRef(config.agents?.defaults?.model)
  if (currentPrimary && getProviderKeyFromModelRef(currentPrimary) === providerKey) {
    delete config.agents!.defaults!.model
  }
}

function removeStaleAuthProfileEntries(
  profiles: Record<string, unknown>,
  configuredProviders: Set<string>
): string[] {
  const removed: string[] = []
  for (const [profileKey, rawProfile] of Object.entries(profiles)) {
    const profile = isPlainRecord(rawProfile) ? rawProfile : {}
    const provider =
      typeof profile.provider === 'string' && profile.provider.trim()
        ? profile.provider.trim()
        : profileKey.split(':')[0]
    if (!STALE_LEGACY_AUTH_PROFILE_PROVIDERS.has(provider)) continue
    if (configuredProviders.has(provider)) continue
    delete profiles[profileKey]
    removed.push(profileKey)
  }
  return removed
}

function cleanupStaleAgentAuthProfiles(configuredProviders: Set<string>): string[] {
  const authProfilesPath = join(OPENCLAW_HOME, 'agents', 'main', 'agent', 'auth-profiles.json')
  if (!existsSync(authProfilesPath)) return []

  try {
    const data = JSON.parse(readFileSync(authProfilesPath, 'utf8')) as Record<string, unknown>
    const profiles = isPlainRecord(data.profiles) ? data.profiles : undefined
    if (!profiles) return []
    const removed = removeStaleAuthProfileEntries(profiles, configuredProviders)
    if (removed.length === 0) return []
    writeFileSync(authProfilesPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    return removed
  } catch (err) {
    log.warn('failed to clean stale local auth profiles', err)
    return []
  }
}

function cleanupStaleLegacyAuth(
  config: OpenclawConfig,
  providers: Record<string, ProviderConfig>
): boolean {
  const configuredProviders = new Set(Object.keys(providers))
  let changed = false
  const removed: string[] = []

  const auth = isPlainRecord(config.auth) ? config.auth : undefined
  const authProfiles = auth && isPlainRecord(auth.profiles) ? auth.profiles : undefined
  if (authProfiles) {
    removed.push(...removeStaleAuthProfileEntries(authProfiles, configuredProviders))
    changed = removed.length > 0
  }

  const pluginEntries = config.plugins?.entries
  if (pluginEntries) {
    for (const pluginKey of STALE_LEGACY_PLUGIN_KEYS) {
      if (pluginEntries[pluginKey]?.enabled === false) continue
      if (!pluginEntries[pluginKey]) continue
      pluginEntries[pluginKey] = { ...pluginEntries[pluginKey], enabled: false }
      changed = true
    }
  }

  const removedAgentProfiles = cleanupStaleAgentAuthProfiles(configuredProviders)
  if (removed.length > 0 || removedAgentProfiles.length > 0) {
    log.info(
      `stale legacy auth profiles removed: config=${removed.join(',') || '-'} agent=${removedAgentProfiles.join(',') || '-'}`
    )
  }
  return changed
}

function ensureProviderTimeout(provider: ProviderConfig): boolean {
  const api = provider.api
  if (
    api &&
    api !== 'openai-completions' &&
    api !== 'openai-responses' &&
    api !== 'anthropic-messages'
  ) {
    return false
  }

  const current =
    typeof provider.timeoutSeconds === 'number'
      ? provider.timeoutSeconds
      : Number(provider.timeoutSeconds)
  if (Number.isFinite(current) && current > 0) return false

  provider.timeoutSeconds = DEFAULT_LLM_TIMEOUT_SECONDS
  return true
}

export function ensureYutianModelRouting(): void {
  const config = readConfig()
  const providers = config.models?.providers
  const defaultModels = config.agents?.defaults?.models
  if (!providers) return

  const yutianModelIds = new Set<string>()
  const firstYutianModelRef = `${YUTIAN_PROVIDER_KEY}/${YUTIAN_MODEL_ID}`
  const existingCanonicalProvider = providers[YUTIAN_PROVIDER_KEY]
  let existingYutianProvider: ProviderConfig | undefined = existingCanonicalProvider
  let changed = false
  for (const [providerKey, provider] of Object.entries(providers)) {
    if (isStaleLegacyProvider(providerKey, provider)) {
      delete providers[providerKey]
      removeDefaultModelRefsForProvider(config, providerKey)
      changed = true
      continue
    }

    if (ensureProviderTimeout(provider)) {
      changed = true
    }

    if (!isYutianProviderKey(providerKey)) continue
    if (!existingYutianProvider) existingYutianProvider = provider

    if (providerKey !== YUTIAN_PROVIDER_KEY) {
      delete providers[providerKey]
      changed = true
      continue
    }
  }

  if (cleanupStaleLegacyAuth(config, providers)) {
    changed = true
  }

  const canonicalProvider = providers[YUTIAN_PROVIDER_KEY] || existingYutianProvider || {}
  const normalizedBaseUrl = normalizeModelBaseUrlForRuntime(
    YUTIAN_MODEL_BASE_URL,
    'openai-completions'
  )
  const nextCanonicalProvider: ProviderConfig = {
    ...canonicalProvider,
    api: 'openai-completions',
    baseUrl: normalizedBaseUrl,
    timeoutSeconds: YUTIAN_MODEL_TIMEOUT_SECONDS,
    models: [
      {
        id: pickPreferredYutianModelId(canonicalProvider.models ?? []),
        name: getYutianProviderModelName(YUTIAN_PROVIDER_KEY),
        input: YUTIAN_MODEL_INPUT,
      },
    ],
  }

  if (JSON.stringify(providers[YUTIAN_PROVIDER_KEY]) !== JSON.stringify(nextCanonicalProvider)) {
    providers[YUTIAN_PROVIDER_KEY] = nextCanonicalProvider
    changed = true
  }

  for (const model of nextCanonicalProvider.models ?? []) {
    const modelId = normalizeModelAliasKey(model.id)
    if (modelId) yutianModelIds.add(modelId)
  }

  if (defaultModels) {
    for (const modelRef of Object.keys(defaultModels)) {
      const providerKey = getProviderKeyFromModelRef(modelRef)
      if (isYutianProviderKey(providerKey) && modelRef !== firstYutianModelRef) {
        delete defaultModels[modelRef]
        changed = true
      }
    }
  }

  if (defaultModels && yutianModelIds.size > 0) {
    for (const [modelRef, entry] of Object.entries(defaultModels)) {
      if (isUnsupportedLegacyModelRef(modelRef)) {
        delete defaultModels[modelRef]
        changed = true
        continue
      }

      if (!entry || typeof entry !== 'object') continue
      if (isYutianProviderKey(getProviderKeyFromModelRef(modelRef))) continue

      const alias = normalizeModelAliasKey(entry.alias)
      if (!alias || !yutianModelIds.has(alias)) continue

      delete entry.alias
      changed = true
    }
  }

  const currentPrimary = getPrimaryModelRef(config.agents?.defaults?.model)
  if (
    !currentPrimary &&
    typeof nextCanonicalProvider.apiKey === 'string' &&
    nextCanonicalProvider.apiKey.trim()
  ) {
    if (!config.agents) config.agents = {}
    if (!config.agents.defaults) config.agents.defaults = {}
    config.agents.defaults.model = {
      primary: firstYutianModelRef,
      fallbacks: [],
    }
    changed = true
  }

  if (
    currentPrimary &&
    (isUnsupportedLegacyModelRef(currentPrimary) || isYutianModelRef(currentPrimary)) &&
    currentPrimary !== firstYutianModelRef
  ) {
    config.agents!.defaults!.model = {
      primary: firstYutianModelRef,
      fallbacks: [],
    }
    changed = true
  }

  if (
    currentPrimary &&
    !isConfiguredModelRef(providers, currentPrimary) &&
    typeof nextCanonicalProvider.apiKey === 'string' &&
    nextCanonicalProvider.apiKey.trim()
  ) {
    if (!config.agents) config.agents = {}
    if (!config.agents.defaults) config.agents.defaults = {}
    config.agents.defaults.model = {
      primary: firstYutianModelRef,
      fallbacks: [],
    }
    changed = true
  }

  const agents = config.agents?.list ?? []
  for (const agent of agents) {
    const agentPrimary = getPrimaryModelRef(agent.model)
    if (!agentPrimary || !isYutianModelRef(agentPrimary) || agentPrimary === firstYutianModelRef) {
      continue
    }

    agent.model =
      typeof agent.model === 'string'
        ? firstYutianModelRef
        : {
            ...agent.model,
            primary: firstYutianModelRef,
            fallbacks: [],
          }
    changed = true
  }

  if (!changed) return
  writeConfig(config, {
    source: 'auto',
    summary: 'YuTian model routing and legacy model cleanup',
  })
  log.info('YuTian model routing and legacy model cleanup applied')
}

export function ensureUnrestrictedToolAccess(): void {
  const config = readConfig()
  const before = JSON.stringify(config)

  config.tools = normalizeUnrestrictedTools(config.tools)

  const skills = ensureRecord(config as unknown as Record<string, unknown>, 'skills')
  const skillLimits = ensureRecord(skills, 'limits')
  skillLimits.maxSkillsPromptChars = DEFAULT_AGENT_SKILLS_PROMPT_CHARS

  if (!config.agents) config.agents = {}
  if (!config.agents.defaults) config.agents.defaults = {}
  const defaults = config.agents.defaults as Record<string, unknown>
  const defaultSandbox = ensureRecord(defaults, 'sandbox')
  defaultSandbox.mode = 'off'
  defaults.elevatedDefault = 'full'
  defaults.bootstrapMaxChars = DEFAULT_AGENT_BOOTSTRAP_MAX_CHARS
  defaults.bootstrapTotalMaxChars = DEFAULT_AGENT_BOOTSTRAP_TOTAL_MAX_CHARS

  const list = config.agents.list ?? []
  if (!list.some((agent) => agent.id === 'main')) {
    list.unshift({ id: 'main' })
  }

  for (const agent of list) {
    agent.tools = normalizeUnrestrictedTools(agent.tools)
    const sandbox = ensureRecord(agent as unknown as Record<string, unknown>, 'sandbox')
    sandbox.mode = 'off'
  }
  config.agents.list = list

  if (JSON.stringify(config) !== before) {
    writeConfig(config, {
      source: 'auto',
      summary: 'YuTianClaw unrestricted local tool access defaults',
    })
    log.info('unrestricted local tool access defaults applied')
  }
}

// ========== 工具函数 ==========

export function ensureIsolatedChannelDmSessions(): void {
  const config = readConfig()
  const session = isPlainRecord(config.session) ? config.session : {}
  const before = JSON.stringify(session)

  if (session.dmScope !== 'per-channel-peer') {
    session.dmScope = 'per-channel-peer'
  }
  config.session = session

  if (JSON.stringify(session) !== before) {
    writeConfig(config, {
      source: 'auto',
      summary: 'Use isolated sessions for channel DMs',
    })
    log.info('channel DM session isolation enabled')
  }
}

export function ensureOpenFeishuAccess(): void {
  const config = readConfig()
  const feishu = config.channels?.feishu
  if (!feishu || typeof feishu !== 'object') return

  const before = JSON.stringify(feishu)
  feishu.dmPolicy = 'open'
  feishu.allowFrom = ['*']
  feishu.groupPolicy = 'open'
  feishu.groupAllowFrom = ['*']
  normalizeFeishuChannelDefaults(feishu)

  if (JSON.stringify(feishu) !== before) {
    writeConfig(config, {
      source: 'auto',
      summary: 'Open Feishu chat access for all senders',
    })
    log.info('Feishu chat access opened for all senders')
  }
}

export function ensureConfiguredChannelPluginEntries(): void {
  const config = readConfig()
  const channels = config.channels && typeof config.channels === 'object' ? config.channels : {}

  const before = JSON.stringify({
    entries: config.plugins?.entries ?? {},
    allow: config.plugins?.allow ?? [],
    bundledDiscovery: config.plugins?.bundledDiscovery,
  })

  for (const [channelKey, channelConfig] of Object.entries(channels)) {
    if (!channelConfig || typeof channelConfig !== 'object' || channelKey === 'defaults') continue
    ensureChannelPluginEntryInConfig(config, channelKey, channelConfig as Record<string, unknown>)
  }
  disableUnconfiguredChannelPluginEntries(config)
  syncPluginAllowlistInConfig(config)

  if (
    JSON.stringify({
      entries: config.plugins?.entries ?? {},
      allow: config.plugins?.allow ?? [],
      bundledDiscovery: config.plugins?.bundledDiscovery,
    }) !== before
  ) {
    writeConfig(config, {
      source: 'auto',
      summary: 'Enable only configured channel plugins',
    })
    log.info('configured channel plugin entries and allowlist synchronized')
  }
}

export function ensureFeishuDefaultAgentRoute(): void {
  const config = readConfig()
  const feishu = isPlainRecord(config.channels?.feishu)
    ? (config.channels?.feishu as Record<string, unknown>)
    : null
  if (!feishu || feishu.enabled === false) return

  const before = JSON.stringify({
    agents: config.agents?.list ?? [],
    bindings: config.bindings ?? [],
  })
  ensureFeishuAgentWorkspaceGuidance()

  if (!config.agents) config.agents = {}
  const list = config.agents.list ?? []
  let feishuAgent = list.find((agent) => agent.id === FEISHU_DEFAULT_AGENT_ID)
  if (!feishuAgent) {
    feishuAgent = {
      id: FEISHU_DEFAULT_AGENT_ID,
      name: FEISHU_DEFAULT_AGENT_NAME,
      identity: {
        name: FEISHU_DEFAULT_AGENT_NAME,
      },
    }
    list.push(feishuAgent)
  } else {
    if (!feishuAgent.name) feishuAgent.name = FEISHU_DEFAULT_AGENT_NAME
    const identity = ensureRecord(feishuAgent as unknown as Record<string, unknown>, 'identity')
    if (!identity.name) identity.name = FEISHU_DEFAULT_AGENT_NAME
  }

  feishuAgent.workspace = FEISHU_DEFAULT_WORKSPACE
  feishuAgent.tools = normalizeChannelChatTools(feishuAgent.tools)
  feishuAgent.skills = CHANNEL_AGENT_SKILLS
  feishuAgent.skillsLimits = { maxSkillsPromptChars: CHANNEL_AGENT_SKILLS_PROMPT_CHARS }
  feishuAgent.bootstrapMaxChars = CHANNEL_AGENT_BOOTSTRAP_MAX_CHARS
  feishuAgent.bootstrapTotalMaxChars = CHANNEL_AGENT_BOOTSTRAP_TOTAL_MAX_CHARS
  feishuAgent.contextInjection = 'always'
  const sandbox = ensureRecord(feishuAgent as unknown as Record<string, unknown>, 'sandbox')
  sandbox.mode = 'off'
  config.agents.list = list

  const bindings = ((config.bindings as BindingConfig[] | undefined) || []).map((binding) => ({
    ...binding,
  }))
  const hasDefaultRoute = bindings.some((binding) => {
    if (!isRouteBinding(binding as Record<string, unknown>)) return false
    const match = normalizeMatch((binding.match || {}) as Record<string, unknown>)
    if (match.channel !== 'feishu') return false
    if ((match.accountId || FEISHU_DEFAULT_ACCOUNT_ID) !== FEISHU_DEFAULT_ACCOUNT_ID) return false
    return !match.peer && !match.guildId && !match.teamId && !match.roles
  })

  if (!hasDefaultRoute) {
    bindings.push({
      type: 'route',
      agentId: FEISHU_DEFAULT_AGENT_ID,
      match: {
        channel: 'feishu',
        accountId: FEISHU_DEFAULT_ACCOUNT_ID,
      },
      comment: 'YuTianClaw default Feishu channel route',
    })
    config.bindings = bindings
  }

  if (
    JSON.stringify({
      agents: config.agents?.list ?? [],
      bindings: config.bindings ?? [],
    }) !== before
  ) {
    writeConfig(config, {
      source: 'auto',
      summary: 'Configure YuTianClaw default Feishu channel agent route',
    })
    log.info('Feishu default channel agent route synchronized')
  }
}

function ensureFeishuAgentWorkspaceGuidance(): void {
  const workspaceDir = join(OPENCLAW_HOME, 'workspace-feishu')
  appendWorkspaceGuidance(workspaceDir, FEISHU_AGENT_GUIDANCE_MARKER, FEISHU_AGENT_GUIDANCE)
  appendWorkspaceGuidance(workspaceDir, CONFIG_SAFETY_GUIDANCE_MARKER, CONFIG_SAFETY_GUIDANCE)
}

function appendWorkspaceGuidance(workspaceDir: string, marker: string, guidance: string): void {
  const guidancePath = join(workspaceDir, 'AGENTS.md')
  try {
    mkdirSync(workspaceDir, { recursive: true })
    const current = existsSync(guidancePath) ? readFileSync(guidancePath, 'utf-8') : ''
    if (current.includes(marker)) return
    const next = current.trim() ? `${current.trimEnd()}\n\n${guidance}\n` : `${guidance}\n`
    writeFileSync(guidancePath, next, 'utf-8')
  } catch (err) {
    log.warn(`failed to ensure workspace guidance: ${workspaceDir}`, err)
  }
}

function ensureWorkspaceDefaultFile(
  workspaceDir: string,
  file: string,
  marker: string,
  defaultMarkers: readonly string[],
  content: string
): void {
  const filePath = join(workspaceDir, file)
  try {
    mkdirSync(workspaceDir, { recursive: true })
    const current = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
    if (current.includes(marker)) return
    const isOpenClawDefault = defaultMarkers.some((item) => current.includes(item))
    if (!current.trim() || isOpenClawDefault) {
      writeFileSync(filePath, `${content.trimEnd()}\n`, 'utf-8')
    }
  } catch (err) {
    log.warn(`failed to ensure workspace file ${file}: ${workspaceDir}`, err)
  }
}

function ensureWorkspaceProductContext(workspaceDir: string): void {
  for (const item of WORKSPACE_FILE_DEFAULTS) {
    ensureWorkspaceDefaultFile(
      workspaceDir,
      item.file,
      item.marker,
      item.defaultMarkers,
      item.content
    )
  }
}

function resolveWorkspaceDir(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  const value = raw.trim()
  if (!value) return fallback
  if (value === '~') return homedir()
  if (/^~[\\/]/.test(value)) return join(homedir(), value.slice(2))
  if (isAbsolute(value)) return value
  return join(OPENCLAW_HOME, value)
}

export function ensureUserFacingAgentGuidance(): void {
  const config = readConfig()
  const workspaceDirs = new Set<string>()
  workspaceDirs.add(
    resolveWorkspaceDir(config.agents?.defaults?.workspace, join(OPENCLAW_HOME, 'workspace'))
  )

  for (const agent of config.agents?.list ?? []) {
    if (agent.workspace) {
      workspaceDirs.add(
        resolveWorkspaceDir(agent.workspace, join(OPENCLAW_HOME, `workspace-${agent.id}`))
      )
    }
  }

  for (const workspaceDir of workspaceDirs) {
    ensureWorkspaceProductContext(workspaceDir)
    appendWorkspaceGuidance(
      workspaceDir,
      USER_FACING_AGENT_GUIDANCE_MARKER,
      USER_FACING_AGENT_GUIDANCE
    )
    appendWorkspaceGuidance(workspaceDir, CONFIG_SAFETY_GUIDANCE_MARKER, CONFIG_SAFETY_GUIDANCE)
  }
}

function ensureChannelPluginEntryInConfig(
  config: OpenclawConfig,
  channelKey: string,
  channelConfig: Record<string, unknown>
): void {
  if (channelConfig.enabled === false) return

  const pluginKey = CHANNEL_PLUGIN_ENTRY_MAP[channelKey]
  if (!pluginKey) return

  if (!config.plugins) config.plugins = {}
  if (!config.plugins.entries) config.plugins.entries = {}

  const current = config.plugins.entries[pluginKey]
  config.plugins.entries[pluginKey] = {
    ...(current ?? {}),
    enabled: true,
  }
}

function getConfiguredChannelPluginIds(config: OpenclawConfig): Set<string> {
  const ids = new Set<string>()
  const channels = config.channels
  if (!channels || typeof channels !== 'object') return ids

  for (const [channelKey, channelConfig] of Object.entries(channels)) {
    if (!channelConfig || typeof channelConfig !== 'object' || channelKey === 'defaults') continue
    if ((channelConfig as Record<string, unknown>).enabled === false) continue
    const pluginKey = CHANNEL_PLUGIN_ENTRY_MAP[channelKey]
    if (pluginKey) ids.add(pluginKey)
  }
  return ids
}

function disableUnconfiguredChannelPluginEntries(config: OpenclawConfig): void {
  const entries = config.plugins?.entries
  if (!entries) return

  const configuredChannelPluginIds = getConfiguredChannelPluginIds(config)
  for (const pluginId of CHANNEL_PLUGIN_IDS) {
    const entry = entries[pluginId]
    if (!entry || entry.enabled !== true) continue
    if (configuredChannelPluginIds.has(pluginId)) continue
    entries[pluginId] = { ...entry, enabled: false }
  }
}

function syncPluginAllowlistInConfig(config: OpenclawConfig): void {
  if (!config.plugins) config.plugins = {}
  if (!config.plugins.entries) config.plugins.entries = {}

  const allowed = new Set(CORE_PLUGIN_ALLOWLIST)
  const configuredChannelPluginIds = getConfiguredChannelPluginIds(config)
  for (const pluginId of configuredChannelPluginIds) {
    allowed.add(pluginId)
  }

  for (const [pluginId, entry] of Object.entries(config.plugins.entries)) {
    if (entry?.enabled !== true) continue
    if (CHANNEL_PLUGIN_IDS.has(pluginId)) continue
    if (STALE_LEGACY_PLUGIN_KEYS.has(pluginId)) continue
    allowed.add(pluginId)
  }

  config.plugins.allow = [...allowed].sort()
  config.plugins.bundledDiscovery = 'allowlist'
}

function firstExistingFile(candidates: string[]): string | undefined {
  return candidates.find((candidate) => candidate && existsSync(candidate))
}

function resolveChromeLikeExecutablePath(): string | undefined {
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    return firstExistingFile([
      join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ])
  }

  if (IS_MAC) {
    return firstExistingFile([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      join(homedir(), 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
    ])
  }

  return firstExistingFile([
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ])
}

function resolveBundledChromeDevtoolsMcpEntry(): string | undefined {
  return firstExistingFile([
    join(YUTIANCLAW_GATEWAY_DIR, ...CHROME_DEVTOOLS_MCP_BIN_RELATIVE),
    join(resolveBundledGatewayDir(), ...CHROME_DEVTOOLS_MCP_BIN_RELATIVE),
  ])
}

function readArgValue(args: unknown, flag: string): string | undefined {
  if (!Array.isArray(args)) return undefined

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (typeof arg !== 'string') continue
    if (arg === flag && typeof args[index + 1] === 'string') return args[index + 1] as string
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1)
  }
  return undefined
}

function looksLikeChromeDevtoolsMcpServer(server: unknown): server is Record<string, unknown> {
  if (!isPlainRecord(server)) return false
  if (typeof server.command === 'string' && server.command.includes(CHROME_DEVTOOLS_MCP_PACKAGE)) {
    return true
  }
  const args = Array.isArray(server.args) ? server.args : []
  return args.some(
    (arg) =>
      typeof arg === 'string' &&
      (arg.includes(CHROME_DEVTOOLS_MCP_PACKAGE) || arg.includes('chrome-devtools-mcp.js'))
  )
}

function buildChromeDevtoolsMcpServer(existing?: Record<string, unknown>): Record<string, unknown> {
  const bundledEntry = resolveBundledChromeDevtoolsMcpEntry()
  const browserPath =
    readArgValue(existing?.args, '--executablePath') || resolveChromeLikeExecutablePath()
  const server: Record<string, unknown> = {}

  if (bundledEntry && existsSync(resolveBundledNodeBin())) {
    server.command = resolveBundledNodeBin()
    server.args = [bundledEntry]
    if (IS_MAC && isPackaged()) {
      server.env = { ELECTRON_RUN_AS_NODE: '1' }
    }
  } else {
    server.command = IS_WIN ? 'npx.cmd' : 'npx'
    server.args = ['-y', `${CHROME_DEVTOOLS_MCP_PACKAGE}@latest`]
  }

  if (browserPath) {
    ;(server.args as string[]).push('--executablePath', browserPath)
  }

  if (!(server.args as string[]).includes('--isolated')) {
    ;(server.args as string[]).push('--isolated')
  }

  server.codex = { defaultToolsApprovalMode: 'approve' }
  return server
}

export function ensureBuiltInMcpServers(config: OpenclawConfig): string[] {
  if (!isPlainRecord(config.mcp)) config.mcp = {}
  if (!isPlainRecord(config.mcp.servers)) config.mcp.servers = {}

  const current = config.mcp.servers[CHROME_DEVTOOLS_MCP_SERVER_NAME]
  if (current && !looksLikeChromeDevtoolsMcpServer(current)) return []

  const next = buildChromeDevtoolsMcpServer(current)
  if (JSON.stringify(current ?? null) === JSON.stringify(next)) return []

  config.mcp.servers[CHROME_DEVTOOLS_MCP_SERVER_NAME] = next
  return [CHROME_DEVTOOLS_MCP_SERVER_NAME]
}

export function repairExternalMcpConfig(): McpCompatibilityRepairResult {
  const config = readConfig()
  const result = normalizeExternalMcpConfig(config)
  const quarantined = quarantineInvalidMcpServers(config)
  if (quarantined.length > 0) {
    result.changed = true
    result.quarantined.push(...quarantined)
  }
  const ensured = ensureBuiltInMcpServers(config)

  if (ensured.length > 0) {
    result.changed = true
    result.ensured.push(...ensured)
  }

  if (!result.changed) return result

  writeConfig(config, {
    source: 'auto',
    summary: 'Synchronize MCP server config',
  })

  log.warn(
    `MCP config synchronized: migrated=${result.migrated.join(',') || '-'} ensured=${result.ensured.join(',') || '-'} quarantined=${result.quarantined.join(',') || '-'} skipped=${result.skipped.join(',') || '-'} removed=${result.removedLegacyKeys.join(',') || '-'}`
  )
  return result
}

export function normalizeExternalMcpConfig(config: OpenclawConfig): McpCompatibilityRepairResult {
  const result: McpCompatibilityRepairResult = {
    changed: false,
    migrated: [],
    skipped: [],
    ensured: [],
    quarantined: [],
    removedLegacyKeys: [],
  }

  for (const legacyKey of ['mcpServers', 'mcp_servers']) {
    if (!Object.hasOwn(config, legacyKey)) continue

    const legacyServers = config[legacyKey]
    if (isPlainRecord(legacyServers)) {
      if (!isPlainRecord(config.mcp)) config.mcp = {}
      if (!isPlainRecord(config.mcp.servers)) config.mcp.servers = {}

      for (const [rawName, rawServer] of Object.entries(legacyServers)) {
        const name = rawName.trim()
        if (!name || !isPlainRecord(rawServer)) {
          result.skipped.push(rawName || legacyKey)
          continue
        }
        if (isPlainRecord(config.mcp.servers[name])) {
          result.skipped.push(name)
          continue
        }

        config.mcp.servers[name] = canonicalizeMcpServer(rawServer)
        result.migrated.push(name)
      }
    } else {
      result.skipped.push(legacyKey)
    }

    delete config[legacyKey]
    result.removedLegacyKeys.push(legacyKey)
    result.changed = true
  }

  return result
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeMcpString(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function resolveOpenclawMcpTransportAlias(value: unknown): 'sse' | 'streamable-http' | undefined {
  const normalized = normalizeMcpString(value)
  if (normalized === 'http' || normalized === 'streamable-http') return 'streamable-http'
  if (normalized === 'sse') return 'sse'
  return undefined
}

function isKnownCliMcpTypeAlias(value: unknown): boolean {
  return ['http', 'streamable-http', 'sse', 'stdio'].includes(normalizeMcpString(value))
}

function canonicalizeMcpServer(server: Record<string, unknown>): Record<string, unknown> {
  const next = { ...server }
  const transportAlias = resolveOpenclawMcpTransportAlias(next.type)
  if (typeof next.transport !== 'string' && transportAlias) {
    next.transport = transportAlias
  }
  if (isKnownCliMcpTypeAlias(next.type)) {
    delete next.type
  }
  return next
}

function basenameForCommand(command: string): string {
  return command.split(/[\\/]/).pop()?.trim().toLowerCase() || command.trim().toLowerCase()
}

function mcpArgs(server: Record<string, unknown>): string[] {
  return Array.isArray(server.args)
    ? server.args.filter((arg): arg is string => typeof arg === 'string')
    : []
}

function looksLikeSelfHostedMcpServer(command: string, args: string[]): boolean {
  const base = basenameForCommand(command)
  const normalizedArgs = args.map((arg) => arg.trim().toLowerCase())
  const joinedArgs = normalizedArgs.join(' ')
  if (/^mcp(\.cmd|\.exe)?$/.test(base) && normalizedArgs[0] === 'serve') return true
  if (/^openclaw(\.cmd|\.exe|\.mjs|\.js)?$/.test(base) && joinedArgs.includes('mcp serve')) {
    return true
  }
  if (joinedArgs.includes('openclaw.mjs') && joinedArgs.includes('mcp serve')) return true
  return false
}

function hasValidMcpUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url.trim()) return false
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function isValidMcpServer(server: unknown): server is Record<string, unknown> {
  if (!isPlainRecord(server)) return false
  const canonical = canonicalizeMcpServer(server)
  if (hasValidMcpUrl(canonical.url)) return true

  const command = typeof canonical.command === 'string' ? canonical.command.trim() : ''
  if (!command) return false
  const args = mcpArgs(canonical)
  if (Array.isArray(canonical.args) && args.length !== canonical.args.length) return false
  if (looksLikeSelfHostedMcpServer(command, args)) return false
  return true
}

export function quarantineInvalidMcpServers(config: OpenclawConfig): string[] {
  const servers = config.mcp?.servers
  if (!isPlainRecord(servers)) return []

  const quarantined: string[] = []
  for (const [name, server] of Object.entries(servers)) {
    if (isValidMcpServer(server)) {
      servers[name] = canonicalizeMcpServer(server)
      continue
    }
    delete servers[name]
    quarantined.push(name)
  }
  return quarantined
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!isPlainRecord(parent[key])) {
    parent[key] = {}
  }
  return parent[key] as Record<string, unknown>
}

function clearRestrictiveToolLists(tools: Record<string, unknown>): void {
  delete tools.allow
  delete tools.deny
  delete tools.byProvider
}

function normalizeUnrestrictedTools(input: unknown): Record<string, unknown> {
  const tools = isPlainRecord(input) ? { ...input } : {}
  clearRestrictiveToolLists(tools)
  tools.profile = 'coding'

  const fsTools = ensureRecord(tools, 'fs')
  fsTools.workspaceOnly = false

  const execTools = ensureRecord(tools, 'exec')
  execTools.host = 'gateway'
  execTools.security = 'full'
  execTools.ask = 'off'
  const applyPatch = ensureRecord(execTools, 'applyPatch')
  applyPatch.enabled = true
  applyPatch.workspaceOnly = false

  const elevated = ensureRecord(tools, 'elevated')
  elevated.enabled = true

  return tools
}

function normalizeChannelChatTools(input: unknown): Record<string, unknown> {
  const original = isPlainRecord(input) ? input : {}
  const legacyAutoDeny = new Set(CHANNEL_AGENT_LEGACY_AUTO_DENY_TOOLS)
  const originalDeny = Array.isArray(original.deny)
    ? original.deny.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0 && !legacyAutoDeny.has(item.trim())
      )
    : []
  const tools = isPlainRecord(input) ? { ...input } : {}
  clearRestrictiveToolLists(tools)
  tools.profile = 'coding'
  const fsTools = ensureRecord(tools, 'fs')
  fsTools.workspaceOnly = false
  const execTools = ensureRecord(tools, 'exec')
  execTools.host = 'gateway'
  execTools.security = 'full'
  execTools.ask = 'off'
  const applyPatch = ensureRecord(execTools, 'applyPatch')
  applyPatch.enabled = true
  applyPatch.workspaceOnly = false
  const elevated = ensureRecord(tools, 'elevated')
  elevated.enabled = true
  tools.deny = Array.from(new Set([...originalDeny, ...CHANNEL_AGENT_DENY_TOOLS])).sort((a, b) =>
    a.localeCompare(b)
  )
  return tools
}

/**
 * 深度合并两个对象（可测试，供单元测试直接导入）
 * - 数组直接替换（不合并）
 * - null/undefined 值会删除目标键
 * - 其余递归合并
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target }

  for (const key of Object.keys(source)) {
    const sourceVal = source[key]
    const targetVal = target[key]

    if (sourceVal === undefined || sourceVal === null) {
      delete result[key]
    } else if (
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal) &&
      targetVal !== null
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>
      )
    } else {
      result[key] = sourceVal
    }
  }

  return result
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let current: Record<string, unknown> = obj

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    if (typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {}
    }
    current = current[key] as Record<string, unknown>
  }

  current[keys[keys.length - 1]] = value
}

function deleteNestedValue(obj: Record<string, unknown>, path: string): void {
  const keys = path.split('.')
  let current: Record<string, unknown> = obj

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    if (typeof current[key] !== 'object' || current[key] === null) return
    current = current[key] as Record<string, unknown>
  }

  delete current[keys[keys.length - 1]]
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.')
  let current: unknown = obj

  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }

  return current
}
