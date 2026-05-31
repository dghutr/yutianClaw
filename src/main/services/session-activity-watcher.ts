import { BrowserWindow } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'fs'
import { basename, join } from 'path'
import { OPENCLAW_HOME } from '../constants'
import { createLogger } from '../logger'

interface SessionActivityItem {
  key: string
  updatedAt?: number
}

const log = createLogger('session-activity')
const AGENTS_DIR = join(OPENCLAW_HOME, 'agents')
const SESSION_ACTIVITY_EVENT = 'gateway:session-activity-changed'

let agentsWatcher: FSWatcher | null = null
let watchers: FSWatcher[] = []
let watchedSessionDirs = new Set<string>()
let sessionIdToKey = new Map<string, string>()
let updatedAtByKey = new Map<string, number>()
let pendingActivity = new Map<string, SessionActivityItem>()
let emitTimer: ReturnType<typeof setTimeout> | null = null
let rescanTimer: ReturnType<typeof setTimeout> | null = null

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function readSessionsIndex(sessionsDir: string): SessionActivityItem[] {
  const indexPath = join(sessionsDir, 'sessions.json')
  if (!existsSync(indexPath)) return []

  const raw = JSON.parse(readFileSync(indexPath, 'utf8')) as Record<string, unknown>
  const items: SessionActivityItem[] = []

  for (const [key, value] of Object.entries(raw)) {
    if (!key || !value || typeof value !== 'object') continue
    const data = value as Record<string, unknown>
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined
    if (sessionId) sessionIdToKey.set(sessionId, key)
    items.push({
      key,
      updatedAt: toNumber(data.updatedAt ?? data.lastInteractionAt),
    })
  }

  return items
}

function queueActivity(item: SessionActivityItem): void {
  if (!item.key) return
  const existing = pendingActivity.get(item.key)
  pendingActivity.set(item.key, {
    key: item.key,
    updatedAt: Math.max(existing?.updatedAt ?? 0, item.updatedAt ?? Date.now()),
  })

  if (emitTimer) return
  emitTimer = setTimeout(() => {
    emitTimer = null
    const sessions = Array.from(pendingActivity.values())
    pendingActivity.clear()
    if (sessions.length === 0) return

    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(SESSION_ACTIVITY_EVENT, {
          sessions,
          ts: Date.now(),
        })
      }
    }
  }, 120)
}

function refreshSessionIndex(sessionsDir: string, emitChanges: boolean): void {
  try {
    const items = readSessionsIndex(sessionsDir)
    for (const item of items) {
      const updatedAt = item.updatedAt ?? 0
      const previous = updatedAtByKey.get(item.key) ?? 0
      updatedAtByKey.set(item.key, updatedAt)
      if (emitChanges && updatedAt > previous) queueActivity(item)
    }
  } catch (err) {
    log.debug('session index refresh skipped:', err)
  }
}

function queueSessionFileActivity(fileName: string | Buffer | null): void {
  if (!fileName) return
  const name = fileName.toString()
  if (!name.endsWith('.jsonl') || name.includes('.trajectory')) return

  const sessionId = basename(name, '.jsonl')
  const key = sessionIdToKey.get(sessionId)
  if (!key) return
  queueActivity({ key, updatedAt: Date.now() })
}

function watchSessionDir(sessionsDir: string): void {
  if (watchedSessionDirs.has(sessionsDir) || !existsSync(sessionsDir)) return
  watchedSessionDirs.add(sessionsDir)
  refreshSessionIndex(sessionsDir, false)

  try {
    const watcher = watch(sessionsDir, (_eventType, fileName) => {
      if (!fileName) return
      const name = fileName.toString()
      if (name === 'sessions.json') {
        refreshSessionIndex(sessionsDir, true)
        return
      }
      queueSessionFileActivity(fileName)
    })
    watchers.push(watcher)
    log.info(`watching session dir: ${sessionsDir}`)
  } catch (err) {
    log.warn(`failed to watch session dir: ${sessionsDir}`, err)
  }
}

function rescanSessionDirs(): void {
  if (!existsSync(AGENTS_DIR)) return
  try {
    for (const entry of readdirSync(AGENTS_DIR)) {
      const sessionsDir = join(AGENTS_DIR, entry, 'sessions')
      if (!existsSync(sessionsDir)) continue
      if (!statSync(sessionsDir).isDirectory()) continue
      watchSessionDir(sessionsDir)
    }
  } catch (err) {
    log.debug('session dir rescan skipped:', err)
  }
}

function scheduleRescanSessionDirs(): void {
  if (rescanTimer) return
  rescanTimer = setTimeout(() => {
    rescanTimer = null
    rescanSessionDirs()
  }, 300)
}

export function startSessionActivityWatcher(): void {
  stopSessionActivityWatcher()
  rescanSessionDirs()

  if (!existsSync(AGENTS_DIR)) return
  try {
    agentsWatcher = watch(AGENTS_DIR, () => {
      scheduleRescanSessionDirs()
    })
    log.info(`watching agents dir: ${AGENTS_DIR}`)
  } catch (err) {
    log.warn(`failed to watch agents dir: ${AGENTS_DIR}`, err)
  }
}

export function stopSessionActivityWatcher(): void {
  if (emitTimer) {
    clearTimeout(emitTimer)
    emitTimer = null
  }
  if (rescanTimer) {
    clearTimeout(rescanTimer)
    rescanTimer = null
  }
  agentsWatcher?.close()
  agentsWatcher = null
  for (const watcher of watchers) watcher.close()
  watchers = []
  watchedSessionDirs = new Set<string>()
  sessionIdToKey = new Map<string, string>()
  updatedAtByKey = new Map<string, number>()
  pendingActivity = new Map<string, SessionActivityItem>()
}
