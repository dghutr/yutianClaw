import { homedir } from 'os'
import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { app } from 'electron'
import AdmZip from 'adm-zip'

// ========== 网络与超时 ==========

export const DEFAULT_PORT = 18789
export const DEFAULT_BIND = 'loopback'
export const HEALTH_CHECK_TIMEOUT_MS = 120_000 // Windows Defender 冷启动慢
export const HEALTH_POLL_INTERVAL_MS = 500
export const CRASH_COOLDOWN_MS = 5_000
export const MAX_RESTART_ATTEMPTS = 3

// ========== 平台判断 ==========

export const IS_WIN = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'

// ========== OpenClaw 用户路径（OpenClaw 自身定义，不可更改） ==========

/** ~/.openclaw */
export const OPENCLAW_HOME = join(homedir(), '.openclaw')
/** ~/.openclaw/openclaw.json */
export const CONFIG_PATH = join(OPENCLAW_HOME, 'openclaw.json')
/** ~/.openclaw/.env */
export const ENV_PATH = join(OPENCLAW_HOME, '.env')
/** ~/.openclaw/config-backups/ */
export const BACKUP_DIR = join(OPENCLAW_HOME, 'config-backups')
/** ~/.openclaw/gateway.log */
export const GATEWAY_LOG_PATH = join(OPENCLAW_HOME, 'gateway.log')

// ========== YuTianClaw 自身数据路径（~/.yutianclaw/） ==========

/**
 * YuTianClaw 数据目录，用于存储 YuTianClaw 自身的缓存和状态，与 OpenClaw 路径完全隔离
 * - macOS / Linux / Windows：~/.yutianclaw/
 */
export const YUTIANCLAW_HOME = join(homedir(), '.yutianclaw')

/** ~/.yutianclaw/app-state.json — UI 状态持久化（侧栏折叠、窗口尺寸等） */
export const APP_STATE_PATH = join(YUTIANCLAW_HOME, 'app-state.json')

/** ~/.yutianclaw/remote-presets-cache.json — 远程预设数据缓存 */
export const REMOTE_PRESETS_CACHE_PATH = join(YUTIANCLAW_HOME, 'remote-presets-cache.json')
export const DEVICE_IDENTITY_PATH = join(YUTIANCLAW_HOME, 'device-identity.json')

/** ~/.yutianclaw/device-auth.json — Gateway 颁发的 deviceToken 持久化 */
export const DEVICE_AUTH_PATH = join(YUTIANCLAW_HOME, 'device-auth.json')

/** ~/.yutianclaw/skill-vet-cache.json — Skill 安全审查结果缓存 */
export const SKILL_VET_CACHE_PATH = join(YUTIANCLAW_HOME, 'skill-vet-cache.json')

/**
 * ~/.yutianclaw/gateway/ — 用户可写的 openclaw 升级目录
 * 升级后的 openclaw 安装到此目录，优先于 app 内置资源
 */
export const YUTIANCLAW_GATEWAY_DIR = join(YUTIANCLAW_HOME, 'gateway')

/**
 * ~/.yutianclaw/bundled-gateway/ — 安装包内置 gateway.zip 的释放缓存。
 *
 * 打包后不再把 gateway 以 2 万多个小文件直接交给 NSIS 安装，
 * 而是在首次真正需要启动 Gateway 时释放到这个用户可写目录。
 */
export const YUTIANCLAW_BUNDLED_GATEWAY_CACHE_DIR = join(YUTIANCLAW_HOME, 'bundled-gateway')

// ========== YuTianClaw 应用数据路径（跟随平台标准） ==========

/**
 * YuTianClaw 应用数据目录
 * - macOS: ~/Library/Application Support/YuTianClaw/
 * - Windows: %LOCALAPPDATA%\YuTianClaw\
 */
export function resolveAppDataDir(): string {
  // Electron 的 app.getPath('userData') 自动处理平台差异
  // macOS: ~/Library/Application Support/YuTianClaw
  // Windows: %APPDATA%\YuTianClaw (Roaming)
  // 但 Windows 更推荐用 LOCALAPPDATA（不跨机器漫游）
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(localAppData, 'YuTianClaw')
  }
  // macOS / Linux: 用 Electron 标准路径
  return app.getPath('userData')
}

/** ~/.yutianclaw/logs/ — YuTianClaw 日志目录 */
export function resolveLogDir(): string {
  return join(YUTIANCLAW_HOME, 'logs')
}

/** ~/.yutianclaw/logs/yutianclaw.log — YuTianClaw 主日志文件 */
export function resolveLogPath(): string {
  return join(resolveLogDir(), 'yutianclaw.log')
}

// ========== 内置资源路径 ==========

/** 判断是否为打包后的环境 */
export function isPackaged(): boolean {
  return app.isPackaged
}

/**
 * 内置资源根路径
 * - 开发模式：项目根目录/resources/targets/<platform-arch>
 * - 打包模式：process.resourcesPath
 */
export function resolveResourcesPath(): string {
  if (isPackaged()) {
    return process.resourcesPath
  }
  const platform = IS_MAC ? 'darwin' : 'win32'
  const arch = process.arch
  return join(app.getAppPath(), 'resources', 'targets', `${platform}-${arch}`)
}

function readGatewayArchiveStamp(resources: string, archivePath: string): string {
  const hashPath = `${archivePath}.sha256`
  try {
    if (existsSync(hashPath)) {
      const hash = readFileSync(hashPath, 'utf-8').trim()
      if (hash) return hash
    }
  } catch {
    // ignore and fall back to file stats
  }

  try {
    const stat = statSync(archivePath)
    return `${stat.size}-${Math.floor(stat.mtimeMs)}`
  } catch {
    return resources.replace(/[^a-z0-9._-]+/gi, '_')
  }
}

function cleanupOldExtractedGateways(cacheRoot: string, keepDir: string): void {
  try {
    if (!existsSync(cacheRoot)) return
    for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(cacheRoot, entry.name)
      if (full === keepDir) continue
      rmSync(full, { recursive: true, force: true })
    }
  } catch {
    // Cache cleanup is best-effort only.
  }
}

export interface BundledGatewayExtractionInfo {
  archivePath: string
  cacheRoot: string
  targetDir: string
  markerPath: string
  entryPath: string
  stamp: string
}

export function getBundledGatewayExtractionInfo(): BundledGatewayExtractionInfo | null {
  const resources = resolveResourcesPath()
  const archivePath = join(resources, 'gateway.zip')
  if (!existsSync(archivePath)) {
    return null
  }

  const stamp = readGatewayArchiveStamp(resources, archivePath)
  const safeStamp = stamp.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 48)
  const targetDir = join(YUTIANCLAW_BUNDLED_GATEWAY_CACHE_DIR, safeStamp)
  const markerPath = join(targetDir, '.yutianclaw-gateway-stamp')
  const entryPath = join(targetDir, 'node_modules', 'openclaw', 'openclaw.mjs')
  return {
    archivePath,
    cacheRoot: YUTIANCLAW_BUNDLED_GATEWAY_CACHE_DIR,
    targetDir,
    markerPath,
    entryPath,
    stamp,
  }
}

export function isBundledGatewayExtracted(
  info: BundledGatewayExtractionInfo | null = getBundledGatewayExtractionInfo()
): boolean {
  if (!info) return true
  try {
    if (
      existsSync(info.entryPath) &&
      existsSync(info.markerPath) &&
      readFileSync(info.markerPath, 'utf-8').trim() === info.stamp
    ) {
      return true
    }
  } catch {
    // A partial extraction will be replaced by the caller.
  }
  return false
}

function ensureBundledGatewayArchiveExtracted(resources: string): string {
  const info = getBundledGatewayExtractionInfo()
  if (!info) {
    return join(resources, 'gateway')
  }

  if (isBundledGatewayExtracted(info)) {
    return info.targetDir
  }

  mkdirSync(info.cacheRoot, { recursive: true })
  const tmpDir = `${info.targetDir}.tmp-${process.pid}-${Date.now()}`
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })

  const zip = new AdmZip(info.archivePath)
  zip.extractAllTo(tmpDir, true)
  writeFileSync(join(tmpDir, '.yutianclaw-gateway-stamp'), info.stamp, 'utf-8')

  if (isBundledGatewayExtracted(info)) {
    rmSync(tmpDir, { recursive: true, force: true })
    return info.targetDir
  }

  rmSync(info.targetDir, { recursive: true, force: true })
  try {
    renameSync(tmpDir, info.targetDir)
  } catch (err) {
    if (isBundledGatewayExtracted(info)) {
      rmSync(tmpDir, { recursive: true, force: true })
      return info.targetDir
    }
    throw err
  }
  cleanupOldExtractedGateways(info.cacheRoot, info.targetDir)

  return info.targetDir
}

/**
 * 内置 Gateway 根目录。
 * - 开发模式：resources/targets/<platform-arch>/gateway
 * - 旧打包：resources/gateway
 * - 新打包：resources/gateway.zip 首次释放到 ~/.yutianclaw/bundled-gateway/<hash>
 */
export function resolveBundledGatewayDir(): string {
  const resources = resolveResourcesPath()
  const directGateway = join(resources, 'gateway')
  if (!isPackaged() || existsSync(join(directGateway, 'node_modules', 'openclaw'))) {
    return directGateway
  }
  return ensureBundledGatewayArchiveExtracted(resources)
}

/**
 * 内置 Node.js 二进制路径
 * - 开发模式：resources/targets/<platform-arch>/runtime/bin/node
 * - macOS 打包：ELECTRON_RUN_AS_NODE=1 复用 Electron Helper
 * - Windows 打包：resources/runtime/node.exe
 */
export function resolveBundledNodeBin(): string {
  const resources = resolveResourcesPath()

  if (!isPackaged()) {
    const ext = IS_WIN ? 'node.exe' : 'bin/node'
    return join(resources, 'runtime', ext)
  }

  if (IS_MAC) {
    const helperPath = process.execPath.replace(
      /\.app\/Contents\/MacOS\/[^/]+$/,
      '.app/Contents/Frameworks/YuTianClaw Helper.app/Contents/MacOS/YuTianClaw Helper'
    )
    return helperPath
  }

  return join(resources, 'runtime', 'node.exe')
}

/**
 * 内置 npm CLI 路径
 */
export function resolveBundledNpmBin(): string {
  const resources = resolveResourcesPath()
  const candidates = IS_WIN
    ? [
        join(resources, 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(resources, 'runtime', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ]
    : [
        join(resources, 'runtime', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(resources, 'runtime', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  // 文件可能尚未生成；返回平台首选路径，供上层日志输出真实目标
  return candidates[0]
}

/**
 * 内置 Gateway 入口文件
 * 优先级：
 *   1. 用户升级目录 ~/.yutianclaw/gateway/node_modules/openclaw/openclaw.mjs
 *   2. app 内置资源 openclaw.mjs（新包名）
 *   3. app 内置资源 gateway-entry.mjs（旧包名回退）
 */
export function resolveBundledGatewayEntry(): string {
  // 优先读取用户升级目录（可写，支持 macOS app bundle 只读限制）
  const userEntry = join(YUTIANCLAW_GATEWAY_DIR, 'node_modules', 'openclaw', 'openclaw.mjs')
  if (existsSync(userEntry)) return userEntry

  // 回退：app 内置资源（只读）
  const gatewayDir = resolveBundledGatewayDir()
  const newEntry = join(gatewayDir, 'node_modules', 'openclaw', 'openclaw.mjs')
  if (existsSync(newEntry)) return newEntry
  return join(gatewayDir, 'node_modules', 'openclaw', 'gateway-entry.mjs')
}

/**
 * 内置 Gateway 工作目录
 * 优先读取用户升级目录，回退 app 内置资源
 */
export function resolveBundledGatewayCwd(): string {
  const userCwd = join(YUTIANCLAW_GATEWAY_DIR, 'node_modules', 'openclaw')
  if (existsSync(userCwd)) return userCwd
  return join(resolveBundledGatewayDir(), 'node_modules', 'openclaw')
}

/**
 * 内置 clawhub CLI 入口文件
 * 安装于 gateway/node_modules/clawhub/bin/clawdhub.js
 */
export function resolveBundledClawhubEntry(): string {
  return join(resolveBundledGatewayDir(), 'node_modules', 'clawhub', 'bin', 'clawdhub.js')
}
