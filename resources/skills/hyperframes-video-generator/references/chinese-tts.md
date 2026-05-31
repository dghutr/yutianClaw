# Chinese TTS Notes

Prefer a natural neural voice for Chinese explainer videos.

## Recommended voices

- `zh-CN-YunxiNeural`: natural male, warm and approachable.
- `zh-CN-YunyangNeural`: male, more formal and news-like.
- `zh-CN-XiaoxiaoNeural`: female, warm.

## Edge TTS

Install if needed:

```bash
python -m pip install edge-tts
```

List voices:

```bash
python -m edge_tts --list-voices
```

Generate male narration:

```bash
python -m edge_tts \
  --voice zh-CN-YunxiNeural \
  --rate "+1%" \
  --pitch "+0Hz" \
  --file narration.txt \
  --write-media narration_male.mp3
```

Convert to WAV and pad or trim to the exact composition duration:

```bash
ffmpeg -y -i narration_male.mp3 \
  -af "apad=pad_dur=1,atrim=0:120" \
  -ar 24000 -ac 1 -c:a pcm_s16le narration.wav
```

If using HyperFrames `tts`, note that Mandarin phonemization may require `espeak-ng`; if it fails, use another TTS path instead of spending time debugging the video composition.
