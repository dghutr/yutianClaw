#!/usr/bin/env python3
"""Generate a subtle original background pad for explainer videos."""

from __future__ import annotations

import argparse
import math
import wave
from pathlib import Path

import numpy as np


def midi_to_hz(midi: int) -> float:
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


def envelope(length_samples: int, sr: int, attack: float = 2.2, release: float = 3.2) -> np.ndarray:
    env = np.ones(length_samples, dtype=np.float32)
    a = min(length_samples, int(attack * sr))
    r = min(length_samples, int(release * sr))
    if a:
        env[:a] *= np.sin(np.linspace(0, math.pi / 2, a, dtype=np.float32)) ** 2
    if r:
        env[-r:] *= np.sin(np.linspace(math.pi / 2, 0, r, dtype=np.float32)) ** 2
    return env


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, help="Output WAV path")
    parser.add_argument("--duration", type=float, default=120.0)
    parser.add_argument("--sample-rate", type=int, default=48000)
    parser.add_argument("--level", type=float, default=0.38, help="Peak level before final mix")
    args = parser.parse_args()

    sr = args.sample_rate
    n = int(sr * args.duration)
    audio = np.zeros((n, 2), dtype=np.float32)

    def add_stereo(sig: np.ndarray, start: float, pan: float) -> None:
        start_i = int(start * sr)
        end_i = min(n, start_i + len(sig))
        if end_i <= start_i:
            return
        sig = sig[: end_i - start_i]
        left = math.cos((pan + 1) * math.pi / 4)
        right = math.sin((pan + 1) * math.pi / 4)
        audio[start_i:end_i, 0] += sig * left
        audio[start_i:end_i, 1] += sig * right

    def add_pad(start: float, length: float, notes: list[int], amp: float = 0.054) -> None:
        length_i = int(length * sr)
        tt = np.arange(length_i, dtype=np.float32) / sr
        env = envelope(length_i, sr)
        movement = 0.88 + 0.12 * np.sin(2 * np.pi * 0.045 * tt + 0.6)
        for idx, midi in enumerate(notes):
            f = midi_to_hz(midi)
            sig = np.zeros(length_i, dtype=np.float32)
            for detune, weight in [(-0.003, 0.55), (0.0, 0.78), (0.004, 0.52)]:
                phase = 2 * np.pi * f * (1 + detune) * tt
                sig += weight * np.sin(phase)
                sig += 0.18 * weight * np.sin(2 * phase + 0.7)
            sig *= amp * env * movement / max(1, len(notes))
            pan = -0.46 + idx * (0.92 / max(1, len(notes) - 1))
            add_stereo(sig, start, pan)

    def add_bell(start: float, midi: int, amp: float, pan: float) -> None:
        length_i = int(2.9 * sr)
        tt = np.arange(length_i, dtype=np.float32) / sr
        f = midi_to_hz(midi)
        env = np.exp(-tt * 1.9).astype(np.float32)
        clickless = np.minimum(1.0, tt / 0.025)
        sig = (
            np.sin(2 * np.pi * f * tt)
            + 0.38 * np.sin(2 * np.pi * f * 2.01 * tt + 0.4)
            + 0.16 * np.sin(2 * np.pi * f * 3.02 * tt + 1.1)
        ).astype(np.float32)
        add_stereo(sig * amp * env * clickless, start, pan)

    def add_pulse(start: float, midi: int, amp: float = 0.015) -> None:
        length_i = int(1.25 * sr)
        tt = np.arange(length_i, dtype=np.float32) / sr
        env = np.exp(-tt * 2.6).astype(np.float32) * np.minimum(1.0, tt / 0.04)
        sig = np.sin(2 * np.pi * midi_to_hz(midi) * tt).astype(np.float32) * amp * env
        add_stereo(sig, start, 0.0)

    chords = [
        [45, 52, 57, 64],
        [41, 48, 55, 64],
        [48, 55, 60, 67],
        [43, 50, 55, 62],
        [45, 52, 60, 64],
        [41, 48, 53, 60],
        [38, 45, 52, 57],
        [48, 55, 60, 64],
    ]

    scene_len = args.duration / len(chords)
    for i, chord in enumerate(chords):
        add_pad(i * scene_len, scene_len + 1.2, chord, amp=0.062 if i in (0, 7) else 0.054)

    rng = np.random.default_rng(20260507)
    for beat in np.arange(scene_len / 2, args.duration - 4, scene_len / 2):
        chord = chords[int(beat // scene_len) % len(chords)]
        note = int(rng.choice(chord)) + 24
        pan = float(rng.uniform(-0.45, 0.45))
        add_bell(float(beat), note, amp=0.024, pan=pan)

    for beat in np.arange(0.0, args.duration, 2.0):
        root = chords[int(beat // scene_len) % len(chords)][0]
        add_pulse(float(beat), root - 12)

    wet = audio.copy()
    for delay_s, gain in [(0.23, 0.20), (0.47, 0.13), (0.89, 0.08), (1.31, 0.05)]:
        d = int(delay_s * sr)
        wet[d:] += audio[:-d] * gain
    audio = wet

    t = np.arange(n, dtype=np.float32) / sr
    fade_in = np.clip(t / 5.0, 0, 1) ** 1.6
    fade_out = np.clip((args.duration - t) / 6.0, 0, 1) ** 1.4
    audio *= np.minimum(fade_in, fade_out)[:, None]

    peak = float(np.max(np.abs(audio)))
    if peak > 0:
        audio = audio / peak * args.level
    pcm16 = (np.clip(audio, -1, 1) * 32767).astype(np.int16)

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(output), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm16.tobytes())
    print(output)


if __name__ == "__main__":
    main()
