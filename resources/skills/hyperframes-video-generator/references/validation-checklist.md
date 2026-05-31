# Validation Checklist

Use this checklist before calling a video final.

## Composition

- `DESIGN.md` exists and the composition follows it.
- Root composition has exact `data-duration`, `data-width`, and `data-height`.
- Timed scenes have `class="clip"`.
- Every scene has entrance animation.
- Multi-scene videos have transitions.
- No exit animations before transitions, except final fade.

## Commands

Run from the HyperFrames project directory:

```bash
npx --yes hyperframes@0.5.3 lint
npx --yes hyperframes@0.5.3 validate
npx --yes hyperframes@0.5.3 inspect --samples 8
npx --yes hyperframes@0.5.3 compositions
```

Then inspect the final MP4:

```bash
ffprobe -v error \
  -show_entries format=duration,size \
  -show_entries stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,duration \
  -of default=noprint_wrappers=1 final.mp4
```

For audio loudness sanity:

```bash
ffmpeg -i final.mp4 -map 0:a:0 -af volumedetect -f null NUL
```

Aim for no clipping and a max volume comfortably below 0 dB. For speech plus background music, around `-8 dB` peak is usually safe.

## Visual QA

Create a contact sheet from scene midpoint frames when the video is not being viewed interactively:

```bash
ffmpeg -ss 6 -i final.mp4 -frames:v 1 frame_006.png
```

Repeat for key scene times, then combine thumbnails with any image tool. Check for scene overlap, unreadable text, missing assets, and accidental test screenshots.
