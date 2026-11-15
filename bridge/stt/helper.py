"""Speech-to-text helper for the ClaudeVR bridge.

The bridge starts this once and keeps it running, so the model loads once
and not on every utterance. It talks JSON lines on stdin and stdout:

  out, once loaded:  {"ready": true, "engine": "...", "model": "...", "loadMs": 1234}
  in:                {"id": 1, "pcm": "<base64 of 16 kHz mono signed 16-bit little-endian>"}
  out:               {"id": 1, "text": "...", "ms": 210}  or  {"id": 1, "error": "..."}

Audio arrives already decoded: the bridge runs ffmpeg, checks the length and
the level, and only sends speech here. Anything a library prints goes to
stderr, which the bridge logs, so stdout carries nothing but replies.
The helper exits when stdin closes, so it dies with the bridge.

  python helper.py --engine parakeet --model mlx-community/parakeet-tdt-0.6b-v3 --cache-dir DIR
  python helper.py --engine whisper  --model small.en
"""

import argparse
import base64
import json
import os
import sys
import time

import numpy as np

# Keep a private handle on the real stdout and point everything else at stderr.
_out = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
sys.stdout = sys.stderr

SAMPLE_RATE = 16000


def reply(obj):
    _out.write(json.dumps(obj) + "\n")
    _out.flush()


def load_parakeet(model, cache_dir):
    import mlx.core as mx
    from parakeet_mlx import from_pretrained
    from parakeet_mlx.audio import get_logmel

    m = from_pretrained(model, cache_dir=cache_dir)
    # Let MLX keep the weights wired, so macOS is less free to page them out
    # between utterances, as mlx-lm does for its models. It did not remove the
    # 1.0-1.3 s stalls seen while a headless Chrome shared the GPU.
    try:
        mx.set_wired_limit(mx.device_info()["max_recommended_working_set_size"])
    except Exception as e:  # older macOS or MLX: carry on unwired, and say so
        print(f"stt helper: could not wire model memory: {e!r}", file=sys.stderr)
    if m.preprocessor_config.sample_rate != SAMPLE_RATE:
        raise RuntimeError(f"model wants {m.preprocessor_config.sample_rate} Hz, bridge sends {SAMPLE_RATE}")

    def run(pcm):
        audio = mx.array(np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0)
        if audio.shape[0] < m.preprocessor_config.hop_length:
            return ""
        mel = get_logmel(audio, m.preprocessor_config)
        return m.generate(mel)[0].text

    warm(run)
    return run


def warm(run):
    # MLX compiles kernels on first use. Low noise at a few lengths gets that
    # done at load (measured: first real clip 431 ms after a silent warm-up,
    # 106 ms after this one), so the first utterance is as quick as the rest.
    rng = np.random.default_rng(0)
    for seconds in (1, 3, 5):
        run((rng.standard_normal(SAMPLE_RATE * seconds) * 1600).astype(np.int16).tobytes())


def load_whisper(model, cache_dir):
    from faster_whisper import WhisperModel

    m = WhisperModel(model, device="cpu", compute_type="int8", download_root=cache_dir)

    def run(pcm):
        audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
        segments, _ = m.transcribe(audio, language="en", beam_size=1, vad_filter=True, condition_on_previous_text=False)
        return " ".join(s.text.strip() for s in segments)

    warm(run)
    return run


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--engine", choices=["parakeet", "whisper"], required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--cache-dir", default=None)
    a = p.parse_args()

    t0 = time.monotonic()
    try:
        run = (load_parakeet if a.engine == "parakeet" else load_whisper)(a.model, a.cache_dir)
    except Exception as e:  # reported to the bridge, which shows it on the HUD
        reply({"ready": False, "error": f"{type(e).__name__}: {e}"[:400]})
        print(f"stt helper: load failed: {e!r}", file=sys.stderr)
        return 3
    reply({"ready": True, "engine": a.engine, "model": a.model, "loadMs": round((time.monotonic() - t0) * 1000)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            pcm = base64.b64decode(req["pcm"])
            t = time.monotonic()
            text = run(pcm).strip()
            reply({"id": rid, "text": text, "ms": round((time.monotonic() - t) * 1000)})
        except Exception as e:  # one bad request must not take the model down
            print(f"stt helper: request {rid} failed: {e!r}", file=sys.stderr)
            reply({"id": rid, "error": f"{type(e).__name__}: {e}"[:400]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
