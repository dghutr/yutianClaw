---
name: hyperframes-video-generator
description: Create polished project explainer, demo, pitch, contest, or promotional videos with HyperFrames HTML, narration, optional neural TTS, generated background music, audio ducking, MP4 rendering, and validation. Use when Codex is asked to generate or revise a video, make a 1-3 minute project walkthrough, add voiceover or background music, turn project assets or slides into a video, or package a final rendered MP4.
---

# HyperFrames Video Generator

## Workflow

1. Stay in the requested project scope. If the user has corrected the project name before, verify the current working directory before creating files.
2. Load the HyperFrames skills (`hyperframes` and `hyperframes-cli`) before authoring or rendering.
3. Create or reuse a video workspace such as `video/<project-name>_hyperframes`.
4. Read or write `DESIGN.md` before editing any composition HTML. Define palette, typography, motion language, and visual constraints.
5. Draft `SCRIPT.md`, `STORYBOARD.md`, and `narration.txt`. Keep narration and on-screen beats aligned by scene.
6. Use real project assets, designed promo images, generated images, or clean mockups. Avoid ugly test screenshots unless the user explicitly wants real debugging footage.
7. Build `index.html` as the source of truth:
   - Root composition uses `data-composition-id`, `data-width`, `data-height`, and exact `data-duration`.
   - Timed scene elements use `class="clip"` plus `data-start`, `data-duration`, and `data-track-index`.
   - Every scene has entrance animation.
   - Multi-scene videos use visible transitions.
   - Do not animate exits except the final scene fade.
8. Generate narration. For Chinese natural voices, prefer neural TTS such as `edge-tts` voices (`zh-CN-YunxiNeural` for natural male, `zh-CN-YunyangNeural` for formal male) when available. Convert the result to a project-local `narration.wav` with the target duration.
9. Add background music only after the voice is accepted. Keep it subtle, fade in/out, and duck it under speech.
10. Validate and render:
    - `npx --yes hyperframes@<version> lint`
    - `npx --yes hyperframes@<version> validate`
    - `npx --yes hyperframes@<version> inspect --samples 8`
    - Render with `npx --yes hyperframes@<version> render --quality standard --fps 30`.
    - Use `ffprobe` to verify duration, resolution, frame rate, and audio tracks.

## Audio

Preserve separate deliverables when useful:

- `*_voice_only.mp4`: accepted narration without music.
- `*_bgm.mp4`: narration plus background music.
- Canonical final file: the path the user expects, updated to the latest accepted version.

Use `scripts/generate_memory_bgm.py` for a calm original pad:

```bash
python scripts/generate_memory_bgm.py --output background_memory_pad.wav --duration 120
```

Use `scripts/mix_bgm_into_video.py` to add music without rerendering frames:

```bash
python scripts/mix_bgm_into_video.py \
  --video renders/final_voice_only.mp4 \
  --bgm background_memory_pad.wav \
  --output renders/final_bgm.mp4
```

The mix script keeps the original video stream, converts audio to AAC stereo, fades the bed, and sidechain-compresses music under voice.

## Recovery

If HyperFrames renders most frames but fails during final MP4 assembly, do not rerender blindly. Check whether a previously validated video exists, then remux:

```bash
ffmpeg -y -i accepted_video.mp4 -i narration.wav \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k \
  -movflags +faststart -shortest final.mp4
```

If `ffmpeg` or `ffprobe` is missing, install or use local static binaries (`ffmpeg-static`, `ffprobe-static`) and set `FFMPEG_PATH`, `FFPROBE_PATH`, and `PATH` for the current shell.

## References

- Read `references/validation-checklist.md` before final handoff.
- Read `references/chinese-tts.md` when the video needs Chinese narration.
