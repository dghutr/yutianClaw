/**
 * OpenClaw 升级服务
 *
 * 方案 B：把新版 openclaw 安装到用户可写目录 ~/.yutianclaw/gateway/，
 * 避开 macOS app bundle 只读限制。
 *
 * 升级后：
 *   - resolveBundledGatewayEntry() / resolveBundledGatewayCwd() 自动优先读取用户目录
 *   - 调用 installCli() 更新 wrapper 脚本中的入口路径
 *   - 由 UI 触发 gateway:restart 使新版生效
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import {
  YUTIANCLAW_GATEWAY_DIR,
  CONFIG_PATH,
  OPENCLAW_HOME,
  resolveBundledNodeBin,
  resolveBundledNpmBin,
  resolveBundledGatewayDir,
} from '../constants'
import { installCli } from './cli-integration'
import { createLogger } from '../logger'
import { readConfig, writeConfig } from '../config'

const log = createLogger('openclaw-updater')

// npm registry 地址（优先 npmmirror，对应站点 https://npmmirror.com/）
// 注意：npm install 需要的是 registry API 端点，不是镜像站首页。
const REGISTRY_MIRRORS = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']
const WEIXIN_PLUGIN_ID = 'openclaw-weixin'
const BUNDLED_SKILL_IDS = ['pdf', 'image2']
const PDF_SKILL_DESCRIPTION = [
  'Built-in YuTianClaw PDF generation tool.',
  'Use it when the user asks to create, export, render, or generate a PDF from text, Markdown, notes, reports, resumes, course material, images, or summaries.',
  'It uses the bundled Node.js runtime and the bundled @napi-rs/canvas PDF engine, so do not tell the user that no PDF tool is installed.',
  'In installed builds, prefer the synced script at ~/.openclaw/skills/pdf/scripts/create-pdf.mjs; do not use resources/gateway paths because gateway is archived and extracted on demand.',
  'For user-visible progress and final replies, use the user language; if the user writes Chinese or the language is ambiguous, use Simplified Chinese.',
  'After creating the PDF, verify the file exists and report its actual size from bytes using 1024-based units.',
].join(' ')

// ─── 类型定义 ───

export type OpenclawUpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'installing'
  | 'done'
  | 'error'

export interface OpenclawUpdateInfo {
  status: OpenclawUpdateStatus
  /** 当前运行版本（用户目录优先，回退内置） */
  currentVersion: string
  /** npm registry 上的最新版本 */
  latestVersion?: string
  error?: string
  /** npm install 流式输出日志行 */
  logLines: string[]
}

// ─── 版本解析 ───

/**
 * 从指定 package.json 读取版本号，读取失败返回 null
 */
function readPackageVersion(pkgJsonPath: string): string | null {
  try {
    if (!existsSync(pkgJsonPath)) return null
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

function readTextIfExists(filePath: string): string | null {
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null
  } catch {
    return null
  }
}

function bundledPluginAlreadySynced(srcDir: string, destDir: string): boolean {
  if (!existsSync(join(destDir, 'openclaw.plugin.json'))) return false

  const srcStamp = readTextIfExists(join(srcDir, '.yutianclaw-stamp.json'))
  const destStamp = readTextIfExists(join(destDir, '.yutianclaw-stamp.json'))
  if (srcStamp && destStamp) return srcStamp === destStamp

  const srcManifest = readTextIfExists(join(srcDir, 'openclaw.plugin.json'))
  const destManifest = readTextIfExists(join(destDir, 'openclaw.plugin.json'))
  return !!srcManifest && srcManifest === destManifest
}

function syncPluginDirIfNeeded(srcDir: string, destDir: string): boolean {
  if (bundledPluginAlreadySynced(srcDir, destDir)) return false
  rmSync(destDir, { recursive: true, force: true })
  cpSync(srcDir, destDir, { recursive: true, dereference: true })
  return true
}

/**
 * 将应用内置的 extensions 同步到用户升级目录中的 openclaw/extensions。
 *
 * 背景：
 * - 安装包构建时，国内 IM 插件被注入到 app resources/gateway/node_modules/openclaw/extensions/
 * - 设置页升级 openclaw 时，会把新版安装到 ~/.yutianclaw/gateway/node_modules/openclaw/
 * - 运行时优先使用用户目录，因此若不复制 extensions，升级后这些插件会“消失”
 */
export function syncBundledExtensionsToUserGateway(onLog: (line: string) => void): string[] {
  const bundledExtensionsDir = resolveBundledExtensionsDir()
  const userOpenclawDir = join(YUTIANCLAW_GATEWAY_DIR, 'node_modules', 'openclaw')
  const userExtensionsDir = join(userOpenclawDir, 'extensions')
  const globalExtensionsDir = join(OPENCLAW_HOME, 'extensions')

  if (!existsSync(bundledExtensionsDir)) {
    const msg = `未找到内置插件目录，跳过同步: ${bundledExtensionsDir}`
    log.warn(msg)
    onLog(`[YuTianClaw] 警告：${msg}`)
    return []
  }

  mkdirSync(userExtensionsDir, { recursive: true })

  const copiedPluginIds: string[] = []
  const globalCopiedPluginIds: string[] = []
  for (const entry of readdirSync(bundledExtensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue

    const srcDir = join(bundledExtensionsDir, entry.name)
    const manifestPath = join(srcDir, 'openclaw.plugin.json')
    if (!existsSync(manifestPath)) continue

    const destDir = join(userExtensionsDir, entry.name)
    if (syncPluginDirIfNeeded(srcDir, destDir)) {
      copiedPluginIds.push(entry.name)
    }

    const globalDestDir = join(globalExtensionsDir, entry.name)
    mkdirSync(globalExtensionsDir, { recursive: true })
    if (syncPluginDirIfNeeded(srcDir, globalDestDir)) {
      globalCopiedPluginIds.push(entry.name)
    }
  }

  if (copiedPluginIds.length > 0) {
    const msg = `已同步内置插件到用户升级目录: ${copiedPluginIds.join(', ')}`
    log.info(msg)
    onLog(`[YuTianClaw] ${msg}`)
    const globalMsg = `已同步内置插件到 OpenClaw 全局扩展目录: ${globalCopiedPluginIds.join(', ')}`
    log.info(globalMsg)
    onLog(`[YuTianClaw] ${globalMsg}`)
  } else {
    const msg = '内置插件已是最新，跳过同步'
    log.info(msg)
    onLog(`[YuTianClaw] ${msg}`)
  }

  return copiedPluginIds
}

/**
 * 将 YuTianClaw 内置 skills 同步到 ~/.openclaw/skills。
 *
 * OpenClaw 会优先加载用户全局 skills；如果机器上已有同名旧 skill，会覆盖掉
 * 应用内置的版本。这里对 YuTianClaw 自带的技能做启动同步，保证“生成 PDF”等
 * 能直接走本地脚本，而不是退回到浏览器打印或提示缺少工具。
 */
export function syncBundledSkillsToGlobalOpenclaw(onLog: (line: string) => void): string[] {
  const bundledSkillsDir = resolveBundledSkillsDir()
  const globalSkillsDir = join(OPENCLAW_HOME, 'skills')

  if (!existsSync(bundledSkillsDir)) {
    const msg = `未找到内置 skill 目录，跳过同步: ${bundledSkillsDir}`
    log.warn(msg)
    onLog(`[YuTianClaw] 警告：${msg}`)
    return []
  }

  mkdirSync(globalSkillsDir, { recursive: true })
  const copiedSkillIds: string[] = []

  for (const skillId of BUNDLED_SKILL_IDS) {
    const srcDir = join(bundledSkillsDir, skillId)
    if (!existsSync(join(srcDir, 'SKILL.md'))) continue

    const destDir = join(globalSkillsDir, skillId)
    rmSync(destDir, { recursive: true, force: true })
    cpSync(srcDir, destDir, { recursive: true, dereference: true })
    copiedSkillIds.push(skillId)
  }

  if (copiedSkillIds.length > 0) {
    const msg = `已同步内置 skill 到 OpenClaw 全局目录: ${copiedSkillIds.join(', ')}`
    log.info(msg)
    onLog(`[YuTianClaw] ${msg}`)
  }

  return copiedSkillIds
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function rewritePdfSkillPrompt(prompt: string): string {
  return prompt.replace(
    /(<name>pdf<\/name>\s*<description>)[\s\S]*?(<\/description>\s*<location>~\/\.openclaw\\skills\\pdf\\SKILL\.md<\/location>)/g,
    `$1${escapeXmlText(PDF_SKILL_DESCRIPTION)}$2`
  )
}

export function refreshBundledSkillSnapshots(onLog: (line: string) => void): number {
  const agentsDir = join(OPENCLAW_HOME, 'agents')
  if (!existsSync(agentsDir)) return 0

  let touchedSessions = 0
  for (const agentEntry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!agentEntry.isDirectory()) continue
    const sessionsPath = join(agentsDir, agentEntry.name, 'sessions', 'sessions.json')
    if (!existsSync(sessionsPath)) continue

    try {
      const data = JSON.parse(readFileSync(sessionsPath, 'utf-8')) as Record<
        string,
        { skillsSnapshot?: { prompt?: string } }
      >
      let changed = false
      for (const session of Object.values(data)) {
        const prompt = session.skillsSnapshot?.prompt
        if (!prompt) continue
        const nextPrompt = rewritePdfSkillPrompt(prompt)
        if (nextPrompt === prompt) continue
        session.skillsSnapshot!.prompt = nextPrompt
        changed = true
        touchedSessions += 1
      }
      if (changed) writeFileSync(sessionsPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
    } catch (err) {
      log.warn(`刷新内置 skill 会话缓存失败: ${sessionsPath}`, err)
    }
  }

  if (touchedSessions > 0) {
    const msg = `已刷新内置 skill 会话缓存: ${touchedSessions} 个会话`
    log.info(msg)
    onLog(`[YuTianClaw] ${msg}`)
  }
  return touchedSessions
}

function resolveBundledExtensionsDir(): string {
  return join(resolveBundledGatewayDir(), 'node_modules', 'openclaw', 'extensions')
}

function resolveUserExtensionsDir(): string {
  return join(YUTIANCLAW_GATEWAY_DIR, 'node_modules', 'openclaw', 'extensions')
}

function isPluginInstalled(dir: string, pluginId: string): boolean {
  return existsSync(join(dir, pluginId, 'openclaw.plugin.json'))
}

function resolveBundledSkillsDir(): string {
  return join(resolveBundledGatewayDir(), 'node_modules', 'openclaw', 'skills')
}

function isSkillInstalled(dir: string, skillId: string): boolean {
  return existsSync(join(dir, skillId, 'SKILL.md'))
}

export function ensureBundledWeixinPluginEnabled(): {
  enabled: boolean
  changed: boolean
  skipped: boolean
} {
  if (!existsSync(CONFIG_PATH)) {
    return { enabled: false, changed: false, skipped: true }
  }

  const cfg = readConfig()
  if (!cfg.plugins) cfg.plugins = {}
  if (!cfg.plugins.entries) cfg.plugins.entries = {}
  const hasConfiguredWeixinChannel =
    !!cfg.channels &&
    typeof cfg.channels === 'object' &&
    !!(cfg.channels as Record<string, unknown>)[WEIXIN_PLUGIN_ID]

  const current = cfg.plugins.entries[WEIXIN_PLUGIN_ID] as { enabled?: boolean } | undefined
  if (!hasConfiguredWeixinChannel) {
    if (current?.enabled === true) {
      cfg.plugins.entries[WEIXIN_PLUGIN_ID] = { ...current, enabled: false }
      writeConfig(cfg, { source: 'auto', summary: 'Disable unused bundled Weixin plugin' })
      log.info(`unused bundled plugin disabled: ${WEIXIN_PLUGIN_ID}`)
      return { enabled: false, changed: true, skipped: true }
    }
    return { enabled: false, changed: false, skipped: true }
  }

  if (current?.enabled === false) {
    return { enabled: false, changed: false, skipped: true }
  }

  if (current?.enabled === true) {
    return { enabled: true, changed: false, skipped: false }
  }

  cfg.plugins.entries[WEIXIN_PLUGIN_ID] = { ...(current ?? {}), enabled: true }
  writeConfig(cfg, { source: 'auto', summary: '启用内置微信插件' })
  log.info(`已默认启用内置插件: ${WEIXIN_PLUGIN_ID}`)
  return { enabled: true, changed: true, skipped: false }
}

export function ensureBundledWeixinReady(onLog: (line: string) => void = () => {}): {
  bundled: boolean
  installedToUserDir: boolean
  enabled: boolean
  configMissing: boolean
} {
  syncBundledExtensionsToUserGateway(onLog)
  const enableResult = ensureBundledWeixinPluginEnabled()
  return {
    bundled: isPluginInstalled(resolveBundledExtensionsDir(), WEIXIN_PLUGIN_ID),
    installedToUserDir: isPluginInstalled(resolveUserExtensionsDir(), WEIXIN_PLUGIN_ID),
    enabled: enableResult.enabled,
    configMissing: enableResult.skipped && !existsSync(CONFIG_PATH),
  }
}

export function ensureBundledSkillsReady(onLog: (line: string) => void = () => {}): {
  bundled: boolean
  installedToGlobalDir: boolean
  copied: string[]
} {
  const copied = syncBundledSkillsToGlobalOpenclaw(onLog)
  refreshBundledSkillSnapshots(onLog)
  return {
    bundled: BUNDLED_SKILL_IDS.every((skillId) =>
      isSkillInstalled(resolveBundledSkillsDir(), skillId)
    ),
    installedToGlobalDir: BUNDLED_SKILL_IDS.every((skillId) =>
      isSkillInstalled(join(OPENCLAW_HOME, 'skills'), skillId)
    ),
    copied,
  }
}

export function getBundledWeixinStatus(): {
  bundled: boolean
  installedToUserDir: boolean
  enabled: boolean
  configMissing: boolean
} {
  const cfgExists = existsSync(CONFIG_PATH)
  const cfg = cfgExists ? readConfig() : {}
  const enabled =
    ((cfg.plugins?.entries?.[WEIXIN_PLUGIN_ID] as { enabled?: boolean } | undefined)?.enabled ??
      false) === true

  return {
    bundled: isPluginInstalled(resolveBundledExtensionsDir(), WEIXIN_PLUGIN_ID),
    installedToUserDir: isPluginInstalled(resolveUserExtensionsDir(), WEIXIN_PLUGIN_ID),
    enabled,
    configMissing: !cfgExists,
  }
}

/**
 * 获取当前运行的 openclaw 版本
 * 优先级：用户目录 > app 内置资源
 */
export function getCurrentOpenclawVersion(): string {
  // 1. 用户升级目录
  const userPkg = join(YUTIANCLAW_GATEWAY_DIR, 'node_modules', 'openclaw', 'package.json')
  const userVersion = readPackageVersion(userPkg)
  if (userVersion) return userVersion

  // 2. app 内置资源
  const bundledPkg = join(resolveBundledGatewayDir(), 'node_modules', 'openclaw', 'package.json')
  const bundledVersion = readPackageVersion(bundledPkg)
  if (bundledVersion) return bundledVersion

  return 'unknown'
}

/**
 * 判断当前版本是否来自用户升级目录（已升级过）
 */
export function isUserUpgraded(): boolean {
  const userPkg = join(YUTIANCLAW_GATEWAY_DIR, 'node_modules', 'openclaw', 'package.json')
  return existsSync(userPkg) && readPackageVersion(userPkg) !== null
}

// ─── Registry 查询 ───

/**
 * 从 npm registry 查询 openclaw 最新版本
 * 依次尝试国内镜像和官方 registry，返回版本号字符串
 */
async function fetchLatestVersion(): Promise<string> {
  const errors: string[] = []
  for (const registry of REGISTRY_MIRRORS) {
    const url = `${registry}/openclaw/latest`
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { version?: string }
      if (!data.version) throw new Error('no version field in response')
      log.info(`从 ${registry} 获取到最新版本: ${data.version}`)
      return data.version
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn(`registry ${registry} 失败: ${msg}`)
      errors.push(`${registry}: ${msg}`)
    }
  }
  throw new Error(`所有 registry 均不可用：${errors.join('; ')}`)
}

// ─── 公开 API ───

/**
 * 检查 openclaw 是否有可用更新
 */
export async function checkOpenclawUpdate(): Promise<OpenclawUpdateInfo> {
  const currentVersion = getCurrentOpenclawVersion()
  const info: OpenclawUpdateInfo = {
    status: 'checking',
    currentVersion,
    logLines: [],
  }

  try {
    const latestVersion = await fetchLatestVersion()
    info.latestVersion = latestVersion

    if (currentVersion === 'unknown') {
      // 无法判断版本，认为有可用更新
      info.status = 'available'
    } else if (latestVersion === currentVersion) {
      info.status = 'up-to-date'
    } else {
      // 简单字符串比较（semver 场景下 npm registry 返回的是最新稳定版，通常更大）
      info.status = 'available'
    }
  } catch (err) {
    info.status = 'error'
    info.error = err instanceof Error ? err.message : String(err)
    log.error('checkOpenclawUpdate failed:', info.error)
  }

  return info
}

/**
 * 执行 openclaw 升级
 *
 * 流程：
 * 1. 创建用户 gateway 目录
 * 2. 用内置 npm 安装指定版本到该目录
 * 3. 流式推送 npm 日志到 onLog 回调
 * 4. 安装成功后更新 CLI wrapper
 *
 * @param version 目标版本号（如 "0.8.5"）
 * @param onLog   日志行回调（流式）
 */
export async function installOpenclawUpdate(
  version: string,
  onLog: (line: string) => void
): Promise<{ success: boolean; error?: string }> {
  log.info(`开始安装 openclaw@${version} 到 ${YUTIANCLAW_GATEWAY_DIR}`)
  onLog(`[YuTianClaw] 开始安装 openclaw@${version}...`)

  // 1. 确保目标目录存在
  try {
    mkdirSync(YUTIANCLAW_GATEWAY_DIR, { recursive: true })
  } catch (err) {
    const msg = `创建目录失败: ${err instanceof Error ? err.message : String(err)}`
    log.error(msg)
    return { success: false, error: msg }
  }

  // 2. 构建 npm install 命令
  const nodeBin = resolveBundledNodeBin()
  const npmCli = resolveBundledNpmBin()
  const packageSpec = `openclaw@${version}`

  // 优先用国内 registry
  const registry = REGISTRY_MIRRORS[0]

  const args = [
    npmCli,
    'install',
    packageSpec,
    '--prefix',
    YUTIANCLAW_GATEWAY_DIR,
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    `--registry=${registry}`,
  ]

  log.info(`执行: ${nodeBin} ${args.join(' ')}`)

  return new Promise((resolve) => {
    const child = spawn(nodeBin, args, {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        // 防止 npm 尝试打开浏览器或交互
        npm_config_yes: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const pushLine = (raw: string): void => {
      raw
        .split('\n')
        .map((l) => l.trimEnd())
        .filter(Boolean)
        .forEach((line) => {
          log.info(`[npm] ${line}`)
          onLog(line)
        })
    }

    child.stdout?.on('data', (chunk: Buffer) => pushLine(chunk.toString('utf-8')))
    child.stderr?.on('data', (chunk: Buffer) => pushLine(chunk.toString('utf-8')))

    child.on('error', (err) => {
      const msg = `npm 进程启动失败: ${err.message}`
      log.error(msg)
      onLog(`[YuTianClaw] 错误：${msg}`)
      resolve({ success: false, error: msg })
    })

    child.on('close', (code) => {
      if (code === 0) {
        log.info(`openclaw@${version} 安装成功`)
        onLog(`[YuTianClaw] openclaw@${version} 安装成功`)

        // 3. 将构建时注入的内置插件同步到用户升级目录
        try {
          syncBundledExtensionsToUserGateway(onLog)
        } catch (err) {
          const msg = `同步内置插件失败: ${err instanceof Error ? err.message : String(err)}`
          log.error(msg)
          onLog(`[YuTianClaw] 错误：${msg}`)
          resolve({ success: false, error: msg })
          return
        }

        // 4. 更新 CLI wrapper（使其指向用户目录中的新版本）
        try {
          installCli()
          log.info('CLI wrapper 已更新')
          onLog('[YuTianClaw] CLI wrapper 已更新')
        } catch (err) {
          log.warn('CLI wrapper 更新失败（不影响升级）:', err)
          onLog(
            `[YuTianClaw] 警告：CLI wrapper 更新失败（${err instanceof Error ? err.message : String(err)}）`
          )
        }

        resolve({ success: true })
      } else {
        const msg = `npm install 退出码: ${code}`
        log.error(msg)
        onLog(`[YuTianClaw] 安装失败（退出码 ${code}）`)
        resolve({ success: false, error: msg })
      }
    })
  })
}
