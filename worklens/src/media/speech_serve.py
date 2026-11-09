"""Long-running speech helper for the Overseer's voice: local speech-to-text and text-to-speech.

Started once by src/overseer/speech.js and kept alive, so the models load one time instead of on
every sentence. One JSON request per stdin line, one JSON reply per stdout line:

  {"id": 1, "op": "stt", "path": "C:/.../said.wav"}             -> {"id": 1, "ok": true, "text": "..."}
  {"id": 2, "op": "tts", "text": "...", "voice": "bm_george",
   "speed": 1.0, "out": "C:/.../reply.wav"}                      -> {"id": 2, "ok": true, "seconds": 2.1}
  {"id": 3, "op": "warm", "what": ["stt", "tts"]}                -> {"id": 3, "ok": true}

Speech-to-text is faster-whisper on the CPU (int8). The model (default base.en) comes from the
local Hugging Face cache; set WORKLENS_WHISPER_MODEL to small.en for better accuracy at roughly
three times the wait. Text-to-speech is Kokoro, the same engine and model files as kokoro_tts.py.
Everything runs on this computer; no audio leaves it.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

_whisper = None
_kokoro = None


def whisper():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel
        name = os.environ.get("WORKLENS_WHISPER_MODEL") or "base.en"
        threads = max(1, min(4, (os.cpu_count() or 2)))
        _whisper = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads)
    return _whisper


def kokoro():
    global _kokoro
    if _kokoro is None:
        from kokoro_tts import model_paths
        from kokoro_onnx import Kokoro
        model, voices, folder, partial = model_paths()
        if not model or not os.path.exists(voices):
            raise RuntimeError(partial or f"Kokoro model files are missing from {folder}.")
        _kokoro = Kokoro(model, voices)
    return _kokoro


def load_audio(path):
    """WAV -> 16 kHz mono float32, without faster-whisper's PyAV decoder (its PyAV call breaks
    on newer PyAV releases)."""
    import numpy as np
    import soundfile as sf
    samples, rate = sf.read(path, dtype="float32", always_2d=True)
    samples = samples.mean(axis=1)
    if rate != 16000 and len(samples):
        target = int(round(len(samples) * 16000 / rate))
        samples = np.interp(np.linspace(0, len(samples) - 1, target), np.arange(len(samples)), samples).astype("float32")
    return samples


def stt(req):
    started = time.time()
    segments, info = whisper().transcribe(
        load_audio(req["path"]), language="en", beam_size=1, vad_filter=True,
        condition_on_previous_text=False, initial_prompt=req.get("prompt") or None,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "audioSeconds": round(info.duration, 2), "took": round(time.time() - started, 2)}


def tts(req):
    import soundfile as sf
    started = time.time()
    text = (req.get("text") or "").strip()
    if not text:
        raise ValueError("Nothing to say.")
    speed = min(max(float(req.get("speed") or 1.0), 0.5), 2.0)
    samples, rate = kokoro().create(text, voice=req.get("voice") or "bm_george", speed=speed, lang=req.get("lang") or "en-us")
    sf.write(req["out"], samples, rate)
    return {"seconds": round(len(samples) / rate, 2), "took": round(time.time() - started, 2)}


def warm(req):
    what = req.get("what") or ["stt", "tts"]
    done = {}
    if "stt" in what:
        whisper(); done["stt"] = True
    if "tts" in what:
        kokoro(); done["tts"] = True
    return done


OPS = {"stt": stt, "tts": tts, "warm": warm}


def main():
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        reply = {"id": req.get("id")}
        try:
            op = OPS.get(req.get("op"))
            if not op:
                raise ValueError(f"Unknown op: {req.get('op')}")
            reply.update(op(req))
            reply["ok"] = True
        except ImportError as error:
            reply.update(ok=False, error=f"Python package missing: {error}")
        except Exception as error:  # report every failure; the helper must keep running
            reply.update(ok=False, error=str(error))
        sys.stdout.write(json.dumps(reply) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
