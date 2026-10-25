"""
Download the AI models once, at build time, into ../models so the app never
needs the internet. Run from the worker's Python environment:

    python worker/download_models.py [--whisper small] [--out models]

Puts:
    models/demucs/htdemucs.yaml + <sig>.th   Demucs htdemucs as a local repo (vocal separation, ~80 MB)
    models/whisper/<name>.pt                 Whisper (transcription + word sync)
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

# Demucs: store a local model repo (a bag .yaml plus its .th weights). The app
# loads it with get_model(name, repo=...), which never touches the network.
# (Plain get_model(name) tries the Hugging Face hub first, even offline.)
print("Downloading Demucs (htdemucs)...")
import shutil  # noqa: E402
import torch  # noqa: E402
import yaml  # noqa: E402
from demucs.pretrained import REMOTE_ROOT, _parse_remote_files, get_model  # noqa: E402

demucs_dir = os.path.join(out, "demucs")
os.makedirs(demucs_dir, exist_ok=True)
bag_yaml = REMOTE_ROOT / "htdemucs.yaml"
shutil.copy(bag_yaml, os.path.join(demucs_dir, "htdemucs.yaml"))
remote = _parse_remote_files(REMOTE_ROOT / "files.txt")
for sig in yaml.safe_load(open(bag_yaml))["models"]:
    url = remote[sig]
    dst = os.path.join(demucs_dir, url.rsplit("/", 1)[-1])
    if not os.path.exists(dst):
        torch.hub.download_url_to_file(url, dst + ".part", progress=True)
        os.replace(dst + ".part", dst)
# prove it loads from the local repo alone
from pathlib import Path  # noqa: E402
get_model("htdemucs", repo=Path(demucs_dir))
print("Demucs OK:", sorted(os.listdir(demucs_dir)))

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
