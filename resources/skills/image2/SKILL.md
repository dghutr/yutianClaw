---
name: image2
description: Built-in YuTianClaw image generation skill powered by the gpt-image-2 model. Use it when the user asks to generate, create, draw, design, or produce a picture, illustration, icon, poster, cover image, visual concept, or other raster image from text.
user-invocable: true
metadata:
  {
    "openclaw":
      {
        "emoji": "🎨",
        "requires": { "bins": ["node"] },
        "primaryEnv": "YUTIAN_IMAGE2_API_KEY",
      },
  }
---

# Image2

Use this built-in YuTianClaw image generation skill whenever the user asks to
generate an image from text.

## API

- Base URL: `https://claw.yutianedu.com`
- Endpoint: `/v1/images/generations`
- Model: `gpt-image-2`
- Auth: `YUTIAN_IMAGE2_API_KEY`

Do not hardcode API keys in files or commands shown to the user. The key should
come from one of these places:

1. `YUTIAN_IMAGE2_API_KEY`
2. `OPENAI_API_KEY`
3. `~/.openclaw/openclaw.json` skill entry `image2.apiKey`
4. `~/.openclaw/openclaw.json` skill entry `yutian-image2.apiKey`

## Quick Start

Installed YuTianClaw on Windows:

```powershell
& "$env:LOCALAPPDATA\Programs\YuTianClaw\resources\runtime\node.exe" `
  "$env:USERPROFILE\.openclaw\skills\image2\scripts\generate-image.mjs" `
  --prompt "A clean red paper-crane app icon on a white background" `
  --out "$env:USERPROFILE\.openclaw\workspace\paper-crane.png"
```

Project checkout:

```bash
node resources/skills/image2/scripts/generate-image.mjs \
  --prompt "A clean red paper-crane app icon on a white background" \
  --out paper-crane.png
```

## Options

- `--prompt <text>`: required unless `--prompt-file` is used.
- `--prompt-file <path>`: read the prompt from a UTF-8 text file.
- `--out <path>`: output image path. Defaults to `image2-<timestamp>.png`.
- `--size <value>`: optional. Prefer omitting it or using `auto`. Some upstream
  routes may fail with fixed sizes such as `1024x1024`.
- `--quality <value>`: optional, for example `low`, `medium`, `high`, or `auto`.
- `--base-url <url>`: defaults to `https://claw.yutianedu.com`.
- `--model <id>`: defaults to `gpt-image-2`.
- `--json`: print machine-readable JSON only.

## Rules

- Always generate a real local image file; do not only describe an image.
- Prefer PNG output unless the user explicitly asks for another format.
- Keep generated files in the current workspace or the destination requested by
  the user.
- Verify the file exists and is non-empty before saying it was created.
- For external channels such as Feishu, attach the image by adding a plain-text
  `MEDIA:` directive on its own line:

```text
Image generated.
MEDIA:C:\Users\name\.openclaw\workspace-feishu\image.png
```

- Do not wrap the `MEDIA:` line in Markdown backticks, code fences, bold text,
  or extra prose.
- User-visible progress and final replies should use the user's language. If
  the user writes Chinese or the language is ambiguous, use Simplified Chinese.
