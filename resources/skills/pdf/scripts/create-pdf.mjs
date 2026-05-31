#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PAGE_SIZES = {
  A4: [595.28, 841.89],
  LETTER: [612, 792],
}

const DEFAULT_FONT_CANDIDATES = [
  'Microsoft YaHei',
  'DengXian',
  'SimSun',
  'Noto Sans CJK SC',
  'Source Han Sans SC',
  'Arial Unicode MS',
  'Arial',
]

function usage() {
  return `YuTianClaw PDF generator

Usage:
  node create-pdf.mjs --input report.md --out report.pdf [--title "Title"]
  node create-pdf.mjs --text "PDF content" --out report.pdf

Options:
  --input <file>      Markdown/text input file. Use "-" to read stdin.
  --text <text>       Inline content.
  --image <file>      Add an image after the text. Can be used more than once.
  --out <file>        Output PDF path. Defaults to <input>.pdf or output.pdf.
  --title <text>      Optional title rendered at the top.
  --subtitle <text>   Optional subtitle rendered under the title.
  --author <text>     Optional footer author label.
  --format <name>     A4 or letter. Default: A4.
  --margin <points>   Page margin. Default: 54.
  --font <family>     Preferred font family. Default: Microsoft YaHei fallback.
  --font-size <size>  Body font size. Default: 12.
  --line-height <n>   Body line-height multiplier. Default: 1.55.
  --list-fonts        Print available font families.
  --help              Show this help.
`
}

function parseArgs(argv) {
  const opts = {
    input: '',
    text: '',
    images: [],
    out: '',
    title: '',
    subtitle: '',
    author: '',
    format: 'A4',
    margin: 54,
    font: '',
    fontSize: 12,
    lineHeight: 1.55,
    help: false,
    listFonts: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`)
    }

    const [rawKey, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined]
    const key = rawKey.slice(2)
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue
      if (i + 1 >= argv.length) throw new Error(`Missing value for --${key}`)
      return argv[++i]
    }

    switch (key) {
      case 'input':
        opts.input = readValue()
        break
      case 'text':
        opts.text = readValue()
        break
      case 'image':
        opts.images.push(readValue())
        break
      case 'out':
        opts.out = readValue()
        break
      case 'title':
        opts.title = readValue()
        break
      case 'subtitle':
        opts.subtitle = readValue()
        break
      case 'author':
        opts.author = readValue()
        break
      case 'format':
        opts.format = readValue().toUpperCase()
        break
      case 'margin':
        opts.margin = Number(readValue())
        break
      case 'font':
        opts.font = readValue()
        break
      case 'font-size':
        opts.fontSize = Number(readValue())
        break
      case 'line-height':
        opts.lineHeight = Number(readValue())
        break
      case 'list-fonts':
        opts.listFonts = true
        break
      case 'help':
      case 'h':
        opts.help = true
        break
      default:
        throw new Error(`Unknown option: --${key}`)
    }
  }

  if (!PAGE_SIZES[opts.format]) throw new Error(`Unsupported format: ${opts.format}`)
  if (!Number.isFinite(opts.margin) || opts.margin < 24) throw new Error('--margin must be at least 24')
  if (!Number.isFinite(opts.fontSize) || opts.fontSize < 8) throw new Error('--font-size must be at least 8')
  if (!Number.isFinite(opts.lineHeight) || opts.lineHeight < 1) throw new Error('--line-height must be at least 1')
  return opts
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function ancestorDirs(start) {
  const dirs = []
  let current = path.resolve(start)
  while (true) {
    dirs.push(current)
    const next = path.dirname(current)
    if (next === current) break
    current = next
  }
  return dirs
}

function parseWrapperAppEntry(wrapperPath) {
  try {
    if (!fs.existsSync(wrapperPath)) return ''
    const content = fs.readFileSync(wrapperPath, 'utf8')
    const windowsMatch = content.match(/set\s+"APP_ENTRY=([^"]+)"/i)
    if (windowsMatch?.[1]) return windowsMatch[1]
    const posixMatch = content.match(/APP_ENTRY="([^"]+)"/)
    if (posixMatch?.[1]) return posixMatch[1]
  } catch {
    // Best-effort discovery only.
  }
  return ''
}

function inferGatewayNodeModulesDirs() {
  const dirs = []

  const nodeExeDir = path.dirname(process.execPath)
  const resourceRootFromNode = path.dirname(nodeExeDir)
  dirs.push(path.join(resourceRootFromNode, 'gateway', 'node_modules'))

  const envRoots = [
    process.env.YUTIANCLAW_RESOURCES_DIR,
    process.env.YUTIANCLAW_GATEWAY_DIR,
    process.env.OPENCLAW_BUNDLED_GATEWAY,
    process.env.OPENCLAW_BUNDLED_GATEWAY_DIR,
  ]
  for (const root of envRoots) {
    if (!root) continue
    dirs.push(path.join(root, 'gateway', 'node_modules'))
    dirs.push(path.join(root, 'node_modules'))
  }

  const binDir = path.join(os.homedir(), '.yutianclaw', 'bin')
  const wrapperNames = process.platform === 'win32' ? ['openclaw.cmd', 'clawhub.cmd'] : ['openclaw', 'clawhub']
  for (const wrapperName of wrapperNames) {
    const appEntry = parseWrapperAppEntry(path.join(binDir, wrapperName))
    if (!appEntry) continue
    dirs.push(path.dirname(path.dirname(appEntry)))
  }

  return unique(dirs)
}

function loadCanvasPackage() {
  const errors = []
  const candidates = []

  candidates.push('@napi-rs/canvas')

  for (const nodeModulesDir of inferGatewayNodeModulesDirs()) {
    candidates.push(path.join(nodeModulesDir, '@napi-rs', 'canvas'))
    candidates.push(path.join(nodeModulesDir, 'openclaw', 'node_modules', '@napi-rs', 'canvas'))
  }

  for (const base of unique([...ancestorDirs(__dirname), ...ancestorDirs(process.cwd())])) {
    candidates.push(path.join(base, 'node_modules', '@napi-rs', 'canvas'))
    candidates.push(
      path.join(
        base,
        'resources',
        'targets',
        `${process.platform}-${process.arch}`,
        'gateway',
        'node_modules',
        '@napi-rs',
        'canvas',
      ),
    )
    candidates.push(
      path.join(
        base,
        'resources',
        'targets',
        `${process.platform}-${process.arch}`,
        'gateway',
        'node_modules',
        'openclaw',
        'node_modules',
        '@napi-rs',
        'canvas',
      ),
    )
  }

  for (const candidate of unique(candidates)) {
    try {
      return require(candidate)
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`)
    }
  }

  throw new Error(
    `Bundled PDF engine @napi-rs/canvas was not found.\nTried:\n${errors.slice(0, 12).join('\n')}`,
  )
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function readInput(opts) {
  let text = opts.text || ''
  let inputDir = process.cwd()

  if (opts.input) {
    if (opts.input === '-') {
      text += await readStdin()
    } else {
      const inputPath = path.resolve(opts.input)
      inputDir = path.dirname(inputPath)
      text += fs.readFileSync(inputPath, 'utf8')
    }
  } else if (!text && !process.stdin.isTTY) {
    text = await readStdin()
  }

  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  return { text, inputDir }
}

function resolveOutputPath(opts) {
  if (opts.out) return path.resolve(opts.out)
  if (opts.input && opts.input !== '-') {
    const parsed = path.parse(path.resolve(opts.input))
    return path.join(parsed.dir, `${parsed.name}.pdf`)
  }
  return path.resolve('output.pdf')
}

function cleanInlineMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/[*_~`]+/g, '')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function parseBlocks(text, inputDir, extraImages) {
  const blocks = []
  const lines = text.split('\n')
  let paragraph = []
  let codeLines = null

  const flushParagraph = () => {
    if (!paragraph.length) return
    const joined = cleanInlineMarkdown(paragraph.join(' ').replace(/\s+/g, ' '))
    if (joined) blocks.push({ type: 'paragraph', text: joined })
    paragraph = []
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/u, '')

    if (/^\s*```/.test(line)) {
      if (codeLines) {
        blocks.push({ type: 'code', text: codeLines.join('\n') })
        codeLines = null
      } else {
        flushParagraph()
        codeLines = []
      }
      continue
    }

    if (codeLines) {
      codeLines.push(rawLine)
      continue
    }

    if (!line.trim()) {
      flushParagraph()
      blocks.push({ type: 'spacer' })
      continue
    }

    const imageMatch = line.match(/^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/)
    if (imageMatch) {
      flushParagraph()
      blocks.push({
        type: 'image',
        caption: cleanInlineMarkdown(imageMatch[1] || ''),
        file: resolveContentPath(imageMatch[2], inputDir),
      })
      continue
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/)
    if (headingMatch) {
      flushParagraph()
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: cleanInlineMarkdown(headingMatch[2]),
      })
      continue
    }

    const bulletMatch = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/)
    if (bulletMatch) {
      flushParagraph()
      blocks.push({ type: 'bullet', text: cleanInlineMarkdown(bulletMatch[1]) })
      continue
    }

    const quoteMatch = line.match(/^\s*>\s*(.+)$/)
    if (quoteMatch) {
      flushParagraph()
      blocks.push({ type: 'quote', text: cleanInlineMarkdown(quoteMatch[1]) })
      continue
    }

    paragraph.push(line.trim())
  }

  if (codeLines) blocks.push({ type: 'code', text: codeLines.join('\n') })
  flushParagraph()

  for (const image of extraImages) {
    blocks.push({ type: 'image', caption: '', file: resolveContentPath(image, inputDir) })
  }

  return compactSpacers(blocks)
}

function compactSpacers(blocks) {
  const result = []
  for (const block of blocks) {
    if (block.type === 'spacer' && (!result.length || result[result.length - 1].type === 'spacer')) continue
    result.push(block)
  }
  while (result.length && result[0].type === 'spacer') result.shift()
  while (result.length && result[result.length - 1].type === 'spacer') result.pop()
  return result
}

function resolveContentPath(value, inputDir) {
  const unquoted = value.trim().replace(/^['"]|['"]$/g, '')
  if (/^https?:\/\//i.test(unquoted)) {
    throw new Error(`Remote images are not supported by this offline PDF tool: ${unquoted}`)
  }
  return path.isAbsolute(unquoted) ? unquoted : path.resolve(inputDir, unquoted)
}

function fontExists(GlobalFonts, name) {
  try {
    if (typeof GlobalFonts.has === 'function') return GlobalFonts.has(name)
    return GlobalFonts.families?.some((item) => item.family === name)
  } catch {
    return false
  }
}

function chooseFont(GlobalFonts, requested) {
  if (requested && fontExists(GlobalFonts, requested)) return requested
  if (requested) return requested
  for (const family of DEFAULT_FONT_CANDIDATES) {
    if (fontExists(GlobalFonts, family)) return family
  }
  return 'Arial'
}

function makeFont(family, size, weight = '400') {
  return `${weight} ${size}px "${family}"`
}

function tokenize(text) {
  return text.match(/[\u3400-\u9fff\uf900-\ufaff]|[^\S\n]+|[^\s\u3400-\u9fff\uf900-\ufaff]+/gu) || [text]
}

function wrapText(ctx, text, maxWidth) {
  const lines = []
  let line = ''

  const pushLine = () => {
    const trimmed = line.trimEnd()
    if (trimmed) lines.push(trimmed)
    line = ''
  }

  const pushOversizedToken = (token) => {
    for (const char of Array.from(token)) {
      const candidate = `${line}${char}`
      if (ctx.measureText(candidate).width <= maxWidth || !line) {
        line = candidate
      } else {
        pushLine()
        line = char
      }
    }
  }

  for (const token of tokenize(text)) {
    if (!line && /^\s+$/u.test(token)) continue
    const candidate = `${line}${token}`
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate
      continue
    }
    if (line) pushLine()
    if (ctx.measureText(token).width > maxWidth) {
      pushOversizedToken(token.trimStart())
    } else {
      line = token.trimStart()
    }
  }

  pushLine()
  return lines.length ? lines : ['']
}

async function renderPdf({ PDFDocument, GlobalFonts, loadImage }, opts, blocks, outPath) {
  const [pageWidth, pageHeight] = PAGE_SIZES[opts.format]
  const margin = opts.margin
  const contentWidth = pageWidth - margin * 2
  const footerHeight = 24
  const contentBottom = pageHeight - margin - footerHeight
  const fontFamily = chooseFont(GlobalFonts, opts.font)
  const doc = new PDFDocument(pageWidth, pageHeight)

  let ctx = null
  let pageNo = 0
  let y = margin

  const startPage = () => {
    ctx = doc.beginPage(pageWidth, pageHeight)
    ctx.textBaseline = 'top'
    ctx.fillStyle = '#111827'
    ctx.strokeStyle = '#e5e7eb'
    ctx.lineWidth = 1
    pageNo += 1
    y = margin
  }

  const finishPage = () => {
    if (!ctx) return
    ctx.save()
    ctx.strokeStyle = '#e5e7eb'
    ctx.beginPath()
    ctx.moveTo(margin, pageHeight - margin + 4)
    ctx.lineTo(pageWidth - margin, pageHeight - margin + 4)
    ctx.stroke()
    ctx.fillStyle = '#6b7280'
    ctx.font = makeFont(fontFamily, 9)
    ctx.textAlign = 'left'
    const footerLeft = opts.author || 'YuTianClaw PDF'
    ctx.fillText(footerLeft, margin, pageHeight - margin + 12)
    ctx.textAlign = 'right'
    ctx.fillText(String(pageNo), pageWidth - margin, pageHeight - margin + 12)
    ctx.restore()
    doc.endPage()
    ctx = null
  }

  const ensurePage = () => {
    if (!ctx) startPage()
  }

  const ensureSpace = (height) => {
    ensurePage()
    if (y + height <= contentBottom) return
    finishPage()
    startPage()
  }

  const addGap = (height) => {
    ensureSpace(height)
    y += height
  }

  const drawLines = (lines, x, maxWidth, { size, weight = '400', color = '#111827', lineHeight, after = 0 }) => {
    ctx.font = makeFont(fontFamily, size, weight)
    ctx.fillStyle = color
    ctx.textAlign = 'left'
    const step = lineHeight || size * opts.lineHeight
    for (const line of lines) {
      ensureSpace(step)
      ctx.font = makeFont(fontFamily, size, weight)
      ctx.fillStyle = color
      ctx.fillText(line, x, y, maxWidth)
      y += step
    }
    if (after) addGap(after)
  }

  const drawWrapped = (text, x, maxWidth, options) => {
    ctx.font = makeFont(fontFamily, options.size, options.weight || '400')
    const lines = wrapText(ctx, text, maxWidth)
    drawLines(lines, x, maxWidth, options)
  }

  const drawCode = (text) => {
    const mono = fontExists(GlobalFonts, 'Consolas') ? 'Consolas' : fontFamily
    const size = Math.max(9, opts.fontSize - 2)
    const step = size * 1.55
    const paddingX = 8
    const paddingY = 5
    const maxWidth = contentWidth - paddingX * 2
    ctx.font = makeFont(mono, size)
    const lines = text.split('\n').flatMap((line) => wrapText(ctx, line || ' ', maxWidth))

    for (const line of lines) {
      ensureSpace(step + paddingY * 2)
      ctx.fillStyle = '#f3f4f6'
      ctx.fillRect(margin, y, contentWidth, step + paddingY * 2)
      ctx.fillStyle = '#111827'
      ctx.font = makeFont(mono, size)
      ctx.fillText(line, margin + paddingX, y + paddingY, maxWidth)
      y += step + paddingY * 2
    }
    addGap(8)
  }

  const drawImageBlock = async (block) => {
    if (!fs.existsSync(block.file)) throw new Error(`Image file not found: ${block.file}`)
    const image = await loadImage(block.file)
    const maxImageHeight = Math.min(360, contentBottom - margin)
    const scale = Math.min(contentWidth / image.width, maxImageHeight / image.height, 1)
    const width = image.width * scale
    const height = image.height * scale
    const captionHeight = block.caption ? opts.fontSize * opts.lineHeight + 8 : 0
    ensureSpace(height + captionHeight + 10)
    const x = margin + (contentWidth - width) / 2
    ctx.drawImage(image, x, y, width, height)
    y += height + 6
    if (block.caption) {
      drawWrapped(block.caption, margin, contentWidth, {
        size: Math.max(9, opts.fontSize - 1),
        color: '#6b7280',
        lineHeight: opts.fontSize * 1.35,
        after: 4,
      })
    } else {
      addGap(10)
    }
  }

  startPage()

  if (opts.title) {
    drawWrapped(opts.title, margin, contentWidth, {
      size: 24,
      weight: '700',
      lineHeight: 31,
      after: opts.subtitle ? 6 : 14,
    })
  }

  if (opts.subtitle) {
    drawWrapped(opts.subtitle, margin, contentWidth, {
      size: 12,
      color: '#6b7280',
      lineHeight: 18,
      after: 18,
    })
  }

  for (const block of blocks) {
    switch (block.type) {
      case 'spacer':
        addGap(8)
        break
      case 'heading': {
        const size = block.level === 1 ? 22 : block.level === 2 ? 17 : 14
        drawWrapped(block.text, margin, contentWidth, {
          size,
          weight: '700',
          lineHeight: size * 1.35,
          after: block.level === 1 ? 12 : 8,
        })
        break
      }
      case 'bullet':
        ensureSpace(opts.fontSize * opts.lineHeight)
        ctx.font = makeFont(fontFamily, opts.fontSize)
        ctx.fillStyle = '#111827'
        ctx.fillText('•', margin + 2, y, 12)
        drawWrapped(block.text, margin + 18, contentWidth - 18, {
          size: opts.fontSize,
          lineHeight: opts.fontSize * opts.lineHeight,
          after: 4,
        })
        break
      case 'quote':
        ctx.strokeStyle = '#d1d5db'
        ensureSpace(opts.fontSize * opts.lineHeight + 8)
        ctx.beginPath()
        ctx.moveTo(margin, y)
        ctx.lineTo(margin, y + opts.fontSize * opts.lineHeight + 8)
        ctx.stroke()
        drawWrapped(block.text, margin + 14, contentWidth - 14, {
          size: opts.fontSize,
          color: '#4b5563',
          lineHeight: opts.fontSize * opts.lineHeight,
          after: 8,
        })
        break
      case 'code':
        drawCode(block.text)
        break
      case 'image':
        await drawImageBlock(block)
        break
      case 'paragraph':
      default:
        drawWrapped(block.text, margin, contentWidth, {
          size: opts.fontSize,
          lineHeight: opts.fontSize * opts.lineHeight,
          after: 8,
        })
        break
    }
  }

  finishPage()

  const pdfBuffer = doc.close()
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, pdfBuffer)
  return { outPath, bytes: pdfBuffer.length, pages: pageNo, fontFamily }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(usage())
    return
  }

  const canvas = loadCanvasPackage()
  if (opts.listFonts) {
    const families = canvas.GlobalFonts?.families || []
    process.stdout.write(`${families.map((item) => item.family).join('\n')}\n`)
    return
  }

  const { text, inputDir } = await readInput(opts)
  if (!text.trim() && !opts.images.length) {
    throw new Error('No input content. Provide --input, --text, --image, or pipe content through stdin.')
  }

  const blocks = parseBlocks(text, inputDir, opts.images)
  const outPath = resolveOutputPath(opts)
  const result = await renderPdf(canvas, opts, blocks, outPath)
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        out: result.outPath,
        bytes: result.bytes,
        pages: result.pages,
        font: result.fontFamily,
      },
      null,
      2,
    ),
  )
  process.stdout.write('\n')
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exit(1)
})
