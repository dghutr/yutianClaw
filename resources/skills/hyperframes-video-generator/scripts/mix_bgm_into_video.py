#!/usr/bin/env python3
"""Mix a subtle BGM bed under an existing voiceover video without rerendering frames."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
from pathlib import Path


def find_executable(name: str, env_var: str | None = None) -> str:
    if env_var and os.environ.get(env_var):
        return os.environ[env_var]
    found = shutil.which(name)
    if found:
        return found
    raise SystemExit(f"Missing {name}. Put it on PATH or set {env_var}.")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True, help="Input MP4 with accepted voiceover")
    parser.add_argument("--bgm", required=True, help="Background music WAV/MP3")
    parser.add_argument("--output", required=True, help="Output MP4")
    parser.add_argument("--bgm-volume", type=float, default=0.17)
    parser.add_argument("--duration", type=float, default=120.0, help="Expected video duration in seconds")
    parser.add_argument("--fade-seconds", type=float, default=4.0)
    parser.add_argument("--voice-backup", help="Optional path to preserve voice-only video")
    parser.add_argument("--ffmpeg", help="Explicit ffmpeg path")
    args = parser.parse_args()

    video = Path(args.video)
    bgm = Path(args.bgm)
    output = Path(args.output)
    if args.voice_backup:
        backup = Path(args.voice_backup)
        backup.parent.mkdir(parents=True, exist_ok=True)
        if not backup.exists():
            shutil.copy2(video, backup)

    ffmpeg = args.ffmpeg or find_executable("ffmpeg", "FFMPEG_PATH")
    tmp = output.with_suffix(".tmp.mp4")
    if tmp.exists():
        tmp.unlink()
    output.parent.mkdir(parents=True, exist_ok=True)

    filter_graph = (
        "[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0,volume=1.0,asplit=2[side][mixvoice];"
        f"[1:a]aresample=48000,volume={args.bgm_volume},"
        f"afade=t=in:st=0:d={args.fade_seconds},"
        f"afade=t=out:st={max(0.0, args.duration - args.fade_seconds)}:d={args.fade_seconds}[bedraw];"
        "[bedraw][side]sidechaincompress=threshold=0.035:ratio=7:attack=45:release=700:makeup=1[bed];"
        "[mixvoice][bed]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.96[aout]"
    )

    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(video),
        "-i",
        str(bgm),
        "-filter_complex",
        filter_graph,
        "-map",
        "0:v:0",
        "-map",
        "[aout]",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        "-shortest",
        str(tmp),
    ]
    subprocess.run(cmd, check=True)
    tmp.replace(output)
    print(output)


if __name__ == "__main__":
    main()
