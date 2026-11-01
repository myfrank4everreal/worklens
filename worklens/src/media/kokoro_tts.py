"""Kokoro text-to-speech helper for the Workstation's Voice tool.

Called by src/media/voice.js as a short-lived process; prints one JSON object to stdout.

  python kokoro_tts.py --list
  python kokoro_tts.py --voice am_onyx --speed 0.95 --text-file line.txt --out line.wav

Model files live in WORKLENS_KOKORO_DIR (default ~/.kokoro): kokoro-v1.0.int8.onnx (or the full
kokoro-v1.0.onnx) and voices-v1.0.bin, from github.com/thewh1teagle/kokoro-onnx releases.
Kokoro's weights are Apache-2.0, so generated speech can be used commercially.
"""
import argparse
import json
import os
import sys


# Smallest complete size of each published model file. A file below this is a download still in
# progress (curl writes straight to the final name), and loading it would crash onnxruntime.
MODELS = (("kokoro-v1.0.int8.onnx", 80_000_000), ("kokoro-v1.0.fp16.onnx", 150_000_000), ("kokoro-v1.0.onnx", 300_000_000))


def model_paths():
    folder = os.environ.get("WORKLENS_KOKORO_DIR") or os.path.join(os.path.expanduser("~"), ".kokoro")
    voices = os.path.join(folder, "voices-v1.0.bin")
    partial = None
    for name, minimum in MODELS:
        model = os.path.join(folder, name)
        if os.path.exists(model):
            size = os.path.getsize(model)
            if size >= minimum:
                return model, voices, folder, None
            partial = f"{name} is still downloading ({size // 1_000_000} of ~{minimum // 1_000_000}+ MB)."
    return None, voices, folder, partial


def fail(message, code=1):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(code)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--voice", default="am_onyx")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--lang", default="en-us")
    parser.add_argument("--text-file")
    parser.add_argument("--out")
    args = parser.parse_args()

    model, voices, folder, partial = model_paths()
    if partial and not model:
        fail(f"Kokoro's model {partial} Voice will be ready when it finishes.")
    if not model or not os.path.exists(voices):
        fail(f"Kokoro model files are missing from {folder}. Download kokoro-v1.0.int8.onnx and voices-v1.0.bin.")
    try:
        from kokoro_onnx import Kokoro
        import soundfile as sf
    except ImportError as error:
        fail(f"Python package missing: {error}. Run: python -m pip install --user kokoro-onnx soundfile")

    kokoro = Kokoro(model, voices)
    if args.list:
        print(json.dumps({"ok": True, "voices": sorted(kokoro.get_voices()), "model": os.path.basename(model)}))
        return

    if not args.text_file or not args.out:
        fail("--text-file and --out are required")
    with open(args.text_file, encoding="utf-8") as handle:
        text = handle.read().strip()
    if not text:
        fail("Nothing to say: the text is empty.")
    speed = min(max(args.speed, 0.5), 2.0)
    samples, rate = kokoro.create(text, voice=args.voice, speed=speed, lang=args.lang)
    sf.write(args.out, samples, rate)
    print(json.dumps({"ok": True, "out": args.out, "seconds": round(len(samples) / rate, 3), "rate": rate}))


if __name__ == "__main__":
    main()
