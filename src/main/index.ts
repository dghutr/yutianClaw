import { app, shell, BrowserWindow, protocol, net, nativeImage } from 'electron'
import { join, isAbsolute, normalize } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { detect } from './runtime'
import { registerIpcHandlers } from './ipc-handlers'
import { getGatewayProcess } from './gateway'
import { createLogger } from './logger'
import { createTray, destroyTray } from './tray'
import { loadAppState, saveAppState } from './config/app-cache'
import { initUpdater } from './services/updater'
import { fetchPresetsInBackground } from './services/remote-presets'
import { getSettings } from './settings'
import { applyElectronProxy } from './utils/proxy'
import { OPENCLAW_HOME } from './constants'
import { cancelAllWeixinQrScans } from './services/weixin-qr'
import {
  startSessionActivityWatcher,
  stopSessionActivityWatcher,
} from './services/session-activity-watcher'
import { prewarmBundledGatewayInBackground } from './services/gateway-prewarm'

// ─── 注册自定义协议（必须在 app.whenReady() 之前调用） ───
//
// 使用 app:// 替代 file:// 加载 renderer，目的：
// - 打包后 WebSocket 握手 Origin 头为 "app://localhost"（而非 file:// 的 "null"）
// - 可将 "app://localhost" 写入 gateway.controlUi.allowedOrigins，只允许 YuTianClaw 自身连接
// - 比 "null" 更安全：任意本地 HTML 文件无法冒充此 origin
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true, // 视为标准 URL（支持相对路径解析）
      secure: true, // 视为安全上下文（等同 https://）
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

const log = createLogger('main')

let mainWindow: BrowserWindow | null = null
let isQuitting = false
const SHOW_MAIN_WINDOW_EVENT = 'yutianclaw:show-main-window'
const MAIN_WINDOW_ROUTES = new Set([
  '/dashboard',
  '/chat',
  '/agents',
  '/channels',
  '/models',
  '/skills',
  '/cron',
  '/logs',
  '/backup',
  '/settings',
  '/about',
])

function getWindowIconPath(): string {
  if (is.dev) return join(__dirname, '../../assets/icon-256.png')
  return process.platform === 'win32'
    ? join(process.resourcesPath, 'icon.ico')
    : join(process.resourcesPath, 'icon-256.png')
}

function normalizeMainWindowRoute(route: unknown): string | null {
  if (typeof route !== 'string') return null
  return MAIN_WINDOW_ROUTES.has(route) ? route : null
}

function navigateMainWindow(win: BrowserWindow, route: string): void {
  const hash = `#${route}`
  const script = `if (window.location.hash !== ${JSON.stringify(hash)}) window.location.hash = ${JSON.stringify(hash)};`
  win.webContents.executeJavaScript(script).catch((err) => {
    log.warn(`navigate main window failed: ${route}`, err)
  })
}

function showOrCreateMainWindow(route?: unknown): void {
  const normalizedRoute = normalizeMainWindowRoute(route)

  if (!mainWindow || mainWindow.isDestroyed()) {
    log.info('main window missing; recreating from tray request')
    createWindow()
  }

  const win = mainWindow
  if (!win || win.isDestroyed()) {
    log.warn('show main window failed: unable to create main window')
    return
  }

  const reveal = (): void => {
    if (win.isDestroyed()) return
    if (normalizedRoute) {
      navigateMainWindow(win, normalizedRoute)
    }
    if (win.isMinimized()) win.restore()
    win.show()
    ;(win as BrowserWindow & { moveTop?: () => void }).moveTop?.()
    win.focus()
  }

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', reveal)
  } else {
    reveal()
  }
}

function createWindow(): void {
  // 恢复上次保存的窗口位置和尺寸
  const savedBounds = loadAppState().windowBounds

  const isMac = process.platform === 'darwin'

  // 开发模式：从源码 assets/ 目录读取；打包模式：从 extraResources 注入的 resources/ 读取
  const iconPath = getWindowIconPath()

  mainWindow = new BrowserWindow({
    ...(savedBounds
      ? { x: savedBounds.x, y: savedBounds.y, width: savedBounds.width, height: savedBounds.height }
      : { width: 1200, height: 800 }),
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'YuTianClaw',
    autoHideMenuBar: true,
    icon: iconPath,
    // macOS：隐藏标题栏保留红绿灯；Windows/Linux：完全无边框，由渲染层 TitleBar 接管
    ...(isMac
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 16, y: 13 } }
      : { frame: false }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL) => {
      log.error(
        `renderer load failed: code=${errorCode}, desc=${errorDescription}, url=${validatedURL}`
      )
    }
  )

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error(`renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`)
  })

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const source = sourceId ? `${sourceId}:${line}` : `line:${line}`
    if (level >= 2) {
      log.error(`[renderer] ${message} (${source})`)
    } else {
      log.debug(`[renderer] ${message} (${source})`)
    }
  })

  // macOS keeps the app resident when closing the window. On Windows we allow
  // the close event to quit, so installers can shut down the app cleanly.
  mainWindow.on('close', (e) => {
    if (process.platform === 'darwin' && !isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  // 保存窗口位置和尺寸（节流：resize/moved 均触发）
  const saveBounds = (): void => {
    if (!mainWindow) return
    try {
      if (mainWindow.isDestroyed() || mainWindow.isMinimized() || mainWindow.isMaximized()) return
      const b = mainWindow.getBounds()
      saveAppState({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } })
    } catch (err) {
      log.warn('saveBounds skipped due to window state error:', err)
    }
  }
  mainWindow.on('resize', saveBounds)
  mainWindow.on('moved', saveBounds)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    if (process.env['YUTIANCLAW_OPEN_DEVTOOLS'] === '1') {
      mainWindow.webContents.openDevTools()
    }
  } else {
    // 使用自定义协议加载，Origin 头为 "app://localhost"
    mainWindow.loadURL('app://localhost')
  }
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showOrCreateMainWindow()
  })

  app.whenReady().then(() => {
    // macOS 开发态默认会显示 "Electron"，这里强制应用名与 About 信息使用产品名
    app.setName('YuTianClaw')
    app.setAboutPanelOptions({
      applicationName: 'YuTianClaw',
      applicationVersion: app.getVersion(),
      version: app.getVersion(),
    })
    if (process.platform === 'darwin' && is.dev) {
      const dockIconPath = join(__dirname, '../../assets/icon.icns')
      const dockIcon = nativeImage.createFromPath(dockIconPath)
      if (!dockIcon.isEmpty()) {
        app.dock?.setIcon(dockIcon)
      } else {
        log.warn('dock icon load failed:', dockIconPath)
      }
    }

    electronApp.setAppUserModelId('cn.yutianclaw.app')

    // 注册 app:// 协议处理器，将请求映射到 renderer 静态文件
    // 打包后：Origin 头固定为 "app://localhost"，写入 allowedOrigins 即可
    protocol.handle('app', async (request) => {
      const url = new URL(request.url)
      if (url.host === 'local-file') {
        const rawPath = url.searchParams.get('path')
        const decodedPath = rawPath ? decodeURIComponent(rawPath) : ''
        const normalizedPath = normalize(decodedPath)
        const mediaRoot = join(OPENCLAW_HOME, 'media')

        // 仅允许读取 ~/.openclaw/media 下的本地媒体，避免任意文件泄露
        if (!decodedPath || !isAbsolute(normalizedPath) || !normalizedPath.startsWith(mediaRoot)) {
          log.warn('Blocked local-file request:', decodedPath)
          return new Response('Forbidden', { status: 403 })
        }

        log.debug('local-file request:', normalizedPath)
        return net.fetch(pathToFileURL(normalizedPath).toString())
      }

      const { pathname } = url
      // pathname='/' → index.html；其余去掉前导 /
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
      const filePath = join(__dirname, '../renderer', relative)
      return net.fetch(`file://${filePath}`)
    })

    // 注册所有 IPC handlers
    registerIpcHandlers()
    app.on(SHOW_MAIN_WINDOW_EVENT as never, (route: unknown) => {
      showOrCreateMainWindow(route)
    })

    // 启动时应用已保存的代理设置到 Electron session
    applyElectronProxy(getSettings()).catch((err) => {
      log.warn('启动时代理设置应用失败:', err)
    })

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    createWindow()
    startSessionActivityWatcher()

    // 创建系统托盘
    if (mainWindow) {
      createTray(mainWindow)
      // 初始化自动更新（注册事件 + 延迟 10s 静默检查）
      initUpdater(mainWindow)
    }

    // 后台静默拉取远程预设（延迟 3s，不阻塞启动）
    fetchPresetsInBackground()
    prewarmBundledGatewayInBackground(0)

    // 启动时执行环境检测
    detect()
      .then((result) => {
        log.info('===== Environment Detection =====')
        log.info(
          'Existing config:',
          result.existingConfig.found
            ? `valid=${result.existingConfig.valid}, providers=${result.existingConfig.hasProviders}, agents=${result.existingConfig.agentCount}`
            : 'none'
        )
        log.info(
          'Gateway:',
          result.existingGateway.running
            ? `running (port=${result.existingGateway.port}, pid=${result.existingGateway.pid})`
            : `stopped (port=${result.existingGateway.port})`
        )
        log.info('Bundled version:', result.bundledOpenclaw.version)
        log.info('=================================')
      })
      .catch((err) => {
        log.error('Environment detection failed:', err)
      })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', async (e) => {
    if (isQuitting) return
    isQuitting = true

    destroyTray()
    cancelAllWeixinQrScans()
    stopSessionActivityWatcher()

    const gw = getGatewayProcess()
    gw.stopStatusPolling()
    if (gw.getState() !== 'stopped') {
      e.preventDefault()
      log.info('stopping gateway before quit...')
      try {
        await gw.stop()
      } catch (err) {
        log.error('gateway stop on quit failed:', err)
      }
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
