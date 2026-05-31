---
name: pdf
description: Built-in YuTianClaw PDF generation tool. Use it when the user asks to create, export, render, or generate a PDF from text, Markdown, notes, reports, resumes, course material, images, or summaries. It uses the bundled Node.js runtime and the bundled @napi-rs/canvas PDF engine, so do not tell the user that no PDF tool is installed.
---

# PDF

Use this built-in PDF skill whenever the user asks to generate a PDF file.

## User-Facing Language

Always write user-visible progress updates, tool summaries, and final replies in
the user's language. If the user writes Chinese or the language is ambiguous,
use Simplified Chinese. Do not use English planning phrases such as "Let me..."
or "Now let me..." unless the user explicitly asks for English. Keep code,
commands, file paths, API names, and quoted source text as-is.

YuTianClaw installs this skill into the user's global OpenClaw skill directory:

```text
~/.openclaw/skills/pdf/
```

Use this global copy as the preferred script location in installed builds. The
generator is self-contained and locates YuTianClaw's bundled PDF engine
automatically. It does not require a separate PDF printer, browser print
workflow, Python package, or system PDF tool.

In a packaged Windows install, if you need an explicit path, use the bundled
runtime with the synced global skill script:

```powershell
& "$env:LOCALAPPDATA\Programs\YuTianClaw\resources\runtime\node.exe" `
  "$env:USERPROFILE\.openclaw\skills\pdf\scripts\create-pdf.mjs" `
  --input "C:\Users\name\.openclaw\workspace-feishu\report.md" `
  --out "C:\Users\name\.openclaw\workspace-feishu\report.pdf"
```

Do not use `resources\gateway\...` in installed builds. New YuTianClaw
installers archive the gateway into `resources\gateway.zip` and extract it on
demand, so that old path may not exist.

## Quick Start

Create a PDF directly from text:

```bash
node skills/pdf/scripts/create-pdf.mjs \
  --text "这是 PDF 内容" \
  --out report.pdf \
  --title "报告"
```

Create a PDF from a Markdown or text file:

```bash
node skills/pdf/scripts/create-pdf.mjs \
  --input report.md \
  --out report.pdf \
  --title "项目报告"
```

Add images:

```bash
node skills/pdf/scripts/create-pdf.mjs \
  --input report.md \
  --image cover.png \
  --out report.pdf
```

When running from the YuTianClaw project checkout, the bundled copy can also be
called explicitly:

```bash
resources/targets/win32-x64/runtime/node.exe \
  resources/skills/pdf/scripts/create-pdf.mjs \
  --input report.md \
  --out report.pdf
```

## Input Format

The script supports plain text and lightweight Markdown:

- `#`, `##`, and `###` headings
- blank-line paragraphs
- `- item` and `1. item` lists
- `>` block quotes
- fenced code blocks
- Markdown images such as `![caption](path/to/image.png)`

Chinese text is supported through system fonts such as Microsoft YaHei and
SimSun on Windows.

## Rules

- Generate a real `.pdf` file with this script; do not call browser print,
  `window.print()`, `Page.printToPDF`, or ask the user to print HTML unless the
  user explicitly asks for HTML.
- Keep the output path inside the user's requested project or destination
  folder.
- After creating the PDF, verify that the file exists and is non-empty.
- When reporting file size, use the actual byte count returned by the script or
  from the generated file. Convert bytes with 1024-based units and do not guess.
- For external channels, keep the final PDF under the channel attachment limit
  before using `MEDIA:`. Feishu supports files up to 30 MB. If the PDF is too
  large, first simplify/compress/split it. If it still cannot fit, do not emit
  a `MEDIA:` line; explain that the file is too large for direct channel
  delivery and offer a smaller version, split files, or a Feishu Drive/cloud
  link workflow.
- In the built-in YuTianClaw chat window, include the generated PDF absolute
  local path in the final reply. YuTianClaw will render it as an attachment and
  open it through Electron's local file API.
- For richer layout, first write structured Markdown content, then run this
  script to render the PDF.
- When the request comes from Feishu or another external chat channel, or when
  the user asks to send/deliver the generated PDF outside the local app, attach
  it by adding a plain-text `MEDIA:` directive on its own line:

```text
PDF generated.
MEDIA:C:\Users\name\.openclaw\workspace-feishu\report.pdf
```

- Do not wrap the `MEDIA:` line in Markdown backticks, code fences, bold text,
  or extra prose. The channel adapter uses this directive to upload the PDF as
  a file attachment.
