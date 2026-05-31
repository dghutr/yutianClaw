import { Worker } from 'worker_threads'
import {
  getBundledGatewayExtractionInfo,
  isBundledGatewayExtracted,
  isPackaged,
} from '../constants'
import { createLogger } from '../logger'

const log = createLogger('gateway-prewarm')

type PrewarmResult = { ok: boolean; elapsedMs?: number; skipped?: boolean; error?: string }

let prewarmTimer: ReturnType<typeof setTimeout> | null = null
let prewarmPromise: Promise<PrewarmResult> | null = null

export function ensureBundledGatewayPrewarmed(): Promise<PrewarmResult> {
  if (!isPackaged()) return Promise.resolve({ ok: true, skipped: true })
  if (prewarmTimer) {
    clearTimeout(prewarmTimer)
    prewarmTimer = null
  }
  if (prewarmPromise) return prewarmPromise

  prewarmPromise = new Promise<PrewarmResult>((resolve) => {
    const info = getBundledGatewayExtractionInfo()
    if (!info || isBundledGatewayExtracted(info)) {
      resolve({ ok: true, skipped: true })
      return
    }

    let admZipPath: string
    try {
      admZipPath = require.resolve('adm-zip')
    } catch (err) {
      log.warn('skip bundled gateway prewarm: adm-zip module not resolved', err)
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
      return
    }

    log.info(`bundled gateway prewarm started: ${info.archivePath}`)
    const worker = new Worker(
      `
const { workerData, parentPort } = require('worker_threads');
const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('fs');
const { join } = require('path');
const AdmZip = require(workerData.admZipPath);

function isReady(info) {
  try {
    return existsSync(info.entryPath) &&
      existsSync(info.markerPath) &&
      readFileSync(info.markerPath, 'utf8').trim() === info.stamp;
  } catch {
    return false;
  }
}

function cleanupOld(cacheRoot, keepDir) {
  try {
    if (!existsSync(cacheRoot)) return;
    for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(cacheRoot, entry.name);
      if (full !== keepDir) rmSync(full, { recursive: true, force: true });
    }
  } catch {}
}

function run() {
const info = workerData.info;
if (isReady(info)) {
  parentPort.postMessage({ ok: true, skipped: true });
} else {
  mkdirSync(info.cacheRoot, { recursive: true });
  const tmpDir = info.targetDir + '.prewarm-' + process.pid + '-' + Date.now();
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const startedAt = Date.now();
  try {
    new AdmZip(info.archivePath).extractAllTo(tmpDir, true);
    writeFileSync(join(tmpDir, '.yutianclaw-gateway-stamp'), info.stamp, 'utf8');
    if (isReady(info)) {
      rmSync(tmpDir, { recursive: true, force: true });
      parentPort.postMessage({ ok: true, skipped: true, elapsedMs: Date.now() - startedAt });
    } else {
      rmSync(info.targetDir, { recursive: true, force: true });
      try {
        renameSync(tmpDir, info.targetDir);
      } catch (err) {
        if (isReady(info)) {
          rmSync(tmpDir, { recursive: true, force: true });
          parentPort.postMessage({ ok: true, skipped: true, elapsedMs: Date.now() - startedAt });
          return;
        }
        throw err;
      }
      cleanupOld(info.cacheRoot, info.targetDir);
      parentPort.postMessage({ ok: true, elapsedMs: Date.now() - startedAt });
    }
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}
}

run();
`,
      {
        eval: true,
        workerData: { info, admZipPath },
      }
    )

    worker.once('message', (message: unknown) => {
      const result = message as PrewarmResult
      if (result.ok) {
        if (result.skipped) {
          log.info('bundled gateway prewarm skipped; cache already ready')
        } else {
          log.info(`bundled gateway prewarm completed in ${result.elapsedMs ?? 0}ms`)
        }
      } else {
        log.warn('bundled gateway prewarm failed:', result.error || message)
      }
      resolve(result)
    })
    worker.once('error', (err) => {
      log.warn('bundled gateway prewarm worker error:', err)
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) })
    })
  }).finally(() => {
    prewarmPromise = null
  })

  return prewarmPromise
}

export function prewarmBundledGatewayInBackground(delayMs = 0): void {
  if (!isPackaged() || prewarmTimer || prewarmPromise) return

  prewarmTimer = setTimeout(() => {
    prewarmTimer = null
    ensureBundledGatewayPrewarmed().catch((err) => {
      log.warn('bundled gateway prewarm failed:', err)
    })
  }, Math.max(0, delayMs))
}
