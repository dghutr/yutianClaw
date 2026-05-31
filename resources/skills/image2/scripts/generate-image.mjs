#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, resolve, join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_BASE_URL = 'https://claw.yutianedu.com'
const DEFAULT_MODEL = 'gpt-image-2'

function printUsage() {
  console.log(`Usage:
  node generate-image.mjs --prompt <text> [--out image.png]
  node generate-image.mjs --prompt-file prompt.txt --out image.png

Options:
  --prompt <text>       Text prompt for image generation.
  --prompt-file <path>  Read prompt from a UTF-8 file.
  --out <path>          Output image path. Defaults to image2-<timestamp>.png.
  --size <value>        Optional image size. Prefer "auto" or omit.
  --quality <value>     Optional quality, e.g. low, medium, high, auto.
  --base-url <url>      Defaults to ${DEFAULT_BASE_URL}.
  --model <id>          Defaults to ${DEFAULT_MODEL}.
  --json                Print JSON only.
  --help                Show this help.
`)
}

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    json: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`)
      return argv[i]
    }

    switch (arg) {
      case '--prompt':
        args.prompt = next()
        break
      case '--prompt-file':
        args.promptFile = next()
        break
      case '--out':
        args.out = next()
        break
      case '--size':
        args.size = next()
        break
      case '--quality':
        args.quality = next()
        break
      case '--base-url':
        args.baseUrl = next()
        break
      case '--model':
        args.model = next()
        break
      case '--json':
        args.json = true
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

function readJsonIfExists(filePath) {
  try {
    if (!existsSync(filePath)) return null
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function getConfigApiKey() {
  const candidates = [
    process.env.OPENCLAW_CONFIG_PATH,
    process.env.OPENCLAW_STATE_DIR ? join(process.env.OPENCLAW_STATE_DIR, 'openclaw.json') : '',
    join(homedir(), '.openclaw', 'openclaw.json'),
  ].filter(Boolean)

  for (const filePath of candidates) {
    const config = readJsonIfExists(filePath)
    const entries = config?.skills?.entries
    const key =
      entries?.image2?.apiKey ||
      entries?.['yutian-image2']?.apiKey ||
      entries?.image2?.config?.apiKey ||
      entries?.['yutian-image2']?.config?.apiKey
    if (typeof key === 'string' && key.trim()) return key.trim()
  }
  return ''
}

function getApiKey() {
  return (
    process.env.YUTIAN_IMAGE2_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    getConfigApiKey()
  )
}

function normalizeOutPath(outPath) {
  const fallback = `image2-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
  const raw = outPath?.trim() || fallback
  const resolved = isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
  return extname(resolved) ? resolved : `${resolved}.png`
}

async function downloadUrl(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300000) })
  if (!res.ok) throw new Error(`Failed to download generated image: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function generateImage(args) {
  const prompt = args.promptFile
    ? readFileSync(resolve(args.promptFile), 'utf-8').trim()
    : args.prompt?.trim()
  if (!prompt) throw new Error('Missing prompt. Use --prompt or --prompt-file.')

  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error('Missing API key. Set YUTIAN_IMAGE2_API_KEY or configure the image2 skill API key.')
  }

  const body = {
    model: args.model || DEFAULT_MODEL,
    prompt,
  }
  if (args.size && args.size !== 'omit') body.size = args.size
  if (args.quality) body.quality = args.quality

  const baseUrl = (args.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const startedAt = Date.now()
  const res = await fetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  })

  const text = await res.text()
  let payload = {}
  if (text.trim()) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: text }
    }
  }

  if (!res.ok) {
    const message =
      payload?.error?.message || payload?.message || text.slice(0, 500) || `HTTP ${res.status}`
    throw new Error(`Image2 request failed: HTTP ${res.status}: ${message}`)
  }

  const first = Array.isArray(payload?.data) ? payload.data[0] : undefined
  let bytes
  if (typeof first?.b64_json === 'string' && first.b64_json.trim()) {
    bytes = Buffer.from(first.b64_json, 'base64')
  } else if (typeof first?.url === 'string' && first.url.trim()) {
    bytes = await downloadUrl(first.url.trim())
  } else {
    throw new Error('Image2 response did not contain data[0].b64_json or data[0].url.')
  }

  if (!bytes.length) throw new Error('Generated image is empty.')

  const outPath = normalizeOutPath(args.out)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, bytes)

  return {
    outPath,
    bytes: bytes.length,
    model: body.model,
    baseUrl,
    durationMs: Date.now() - startedAt,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }

  const result = await generateImage(args)
  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Image generated: ${result.outPath}`)
  console.log(`Bytes: ${result.bytes}`)
  console.log(`Duration: ${result.durationMs} ms`)
  console.log(`MEDIA:${result.outPath}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
