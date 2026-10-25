"""
Download the AI models once, at build time, into ../models so the app never
needs the internet. Run from the worker's Python environment:

    python worker/download_models.py [--whisper small] [--out models]

Puts:
    models/torch/hub/checkpoints/*.th   Demucs htdemucs (vocal separation, ~80 MB)
    models/whisper/<name>.pt            Whisper (transcription + word sync)
"""
import argparse
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
p = argparse.ArgumentParser()
p.add_argument("--whisper", default=os.environ.get("SINGLINE_WHISPER_MODEL", "small"),
               help="tiny | base | small | medium | large-v3 (bigger = more accurate, larger installer)")
p.add_argument("--out", default=os.path.join(here, "..", "models"))
args = p.parse_args()

out = os.path.abspath(args.out)
os.makedirs(os.path.join(out, "whisper"), exist_ok=True)
os.environ["TORCH_HOME"] = os.path.join(out, "torch")

print("Downloading Demucs (htdemucs)...")
from demucs.pretrained import get_model  # noqa: E402
get_model("htdemucs")

print("Downloading Whisper (%s)..." % args.whisper)
import whisper  # noqa: E402
url = whisper._MODELS[args.whisper]
whisper._download(url, os.path.join(out, "whisper"), in_memory=False)
src = os.path.join(out, "whisper", os.path.basename(url))
dst = os.path.join(out, "whisper", args.whisper + ".pt")
if os.path.abspath(src) != os.path.abspath(dst):
    os.replace(src, dst)

print("Models ready in", out)
sys.exit(0)
