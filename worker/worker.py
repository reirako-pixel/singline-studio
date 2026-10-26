"""
SingLine Studio - offline AI worker.

Runs one job per process and talks to the Electron app with JSON lines on stdout:
    {"type": "progress", "pct": 0-100, "msg": "..."}
    {"type": "result", ...}
    {"type": "error", "message": "..."}
Everything libraries print goes to stderr so stdout stays clean.

Commands
    info                                    device / model availability
    separate   --input F --outdir D         vocals.wav + instrumental.wav + mix.wav
    align      --audio F --lyrics F [--lang L]   sync given lyrics to the vocals
    transcribe --audio F [--lang L]         write the lyrics out from the vocals
Common options: --models DIR  --ffmpeg PATH  --whisper-model NAME  --device auto|cpu|cuda
"""
import argparse
import difflib
import io
import json
import os
import re
import subprocess
import sys
import time
import traceback
import unicodedata

# ---------------------------------------------------------------------------
# Protocol: keep a private handle to the real stdout, route everything else
# (library prints, warnings) to stderr.
# ---------------------------------------------------------------------------
_PROTO = io.TextIOWrapper(sys.__stdout__.buffer, encoding="utf-8", line_buffering=True)
sys.stdout = sys.stderr

_stage = [0.0, 100.0]  # current stage range in overall percent
_last_emit = [0.0, -1.0]


def emit(obj):
    _PROTO.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _PROTO.flush()


def progress(pct, msg=None):
    now = time.time()
    if msg is None and pct - _last_emit[1] < 0.5 and now - _last_emit[0] < 1.0:
        return
    _last_emit[0], _last_emit[1] = now, pct
    out = {"type": "progress", "pct": round(max(0.0, min(100.0, pct)), 1)}
    if msg:
        out["msg"] = msg
    emit(out)


def stage(lo, hi, msg):
    _stage[0], _stage[1] = lo, hi
    progress(lo, msg)


def stage_frac(frac):
    lo, hi = _stage
    progress(lo + (hi - lo) * max(0.0, min(1.0, frac)))


# ---------------------------------------------------------------------------
# Turn library progress bars (tqdm) into protocol progress events. Must run
# before demucs / whisper / stable_whisper are imported.
# ---------------------------------------------------------------------------
def _patch_tqdm():
    import tqdm as _tq
    import tqdm.auto as _tqa

    _Orig = _tq.tqdm

    class JsonTqdm(_Orig):
        def __init__(self, *a, **k):
            k["disable"] = False
            k["file"] = open(os.devnull, "w", encoding="utf-8")
            k["mininterval"] = 0.2
            super().__init__(*a, **k)

        def update(self, n=1):
            r = super().update(n)
            if self.total:
                stage_frac(self.n / self.total)
            return r

    _tq.tqdm = JsonTqdm
    _tqa.tqdm = JsonTqdm
    try:
        import tqdm.std as _tqs
        _tqs.tqdm = JsonTqdm
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
def setup_env(args):
    models = os.path.abspath(args.models)
    # Demucs weights live in the torch hub cache; point it at the bundled copy
    # so nothing is ever downloaded at runtime.
    os.environ["TORCH_HOME"] = os.path.join(models, "torch")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    if args.ffmpeg and os.path.sep in args.ffmpeg:
        os.environ["PATH"] = os.path.dirname(os.path.abspath(args.ffmpeg)) + os.pathsep + os.environ.get("PATH", "")
    return models


def pick_device(pref):
    import torch
    if pref == "cpu":
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if pref == "cuda":
        raise RuntimeError("An NVIDIA GPU was requested but CUDA is not available on this PC.")
    return "cpu"


def whisper_path(models, name):
    return os.path.join(models, "whisper", name + ".pt")


# ---------------------------------------------------------------------------
# Audio helpers (ffmpeg does all decoding so any format / video works)
# ---------------------------------------------------------------------------
def decode_audio(ffmpeg, path, sr, channels):
    import numpy as np
    cmd = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", path,
           "-vn", "-f", "f32le", "-acodec", "pcm_f32le", "-ac", str(channels), "-ar", str(sr), "-"]
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=flags)
    if proc.returncode != 0:
        raise RuntimeError("Could not read the audio: " + proc.stderr.decode("utf-8", "replace").strip()[-400:])
    data = np.frombuffer(proc.stdout, dtype=np.float32)
    if data.size == 0:
        raise RuntimeError("The file has no audio track.")
    return data.reshape(-1, channels).T.copy()  # (channels, samples)


def write_wav(path, data, sr):
    import numpy as np
    import soundfile as sf
    sf.write(path, np.clip(data.T, -1.0, 1.0), sr, subtype="PCM_16")


# ---------------------------------------------------------------------------
# Lyrics tokenisation. Must match tokenize() in src/lib/lyrics.js.
# Space-separated scripts split on whitespace; CJK / kana / Thai split per
# character with trailing punctuation kept on the previous character.
# ---------------------------------------------------------------------------
_NOSPACE = re.compile(r"[぀-ヿ㐀-䶿一-鿿豈-﫿฀-๿ｦ-ﾟ]")


def _is_punct(ch):
    return unicodedata.category(ch).startswith("P")


def tokenize(line):
    tokens = []
    for chunk in line.split():
        if not _NOSPACE.search(chunk):
            tokens.append(chunk)
            continue
        cur = ""
        for ch in chunk:
            if _NOSPACE.match(ch):
                if cur:
                    tokens.append(cur)
                cur = ch
            elif _is_punct(ch) and cur:
                cur += ch
            else:
                if cur and _NOSPACE.match(cur[-1]):
                    tokens.append(cur)
                    cur = ""
                cur += ch
        if cur:
            tokens.append(cur)
    return tokens


def _norm_chars(text):
    """Comparable characters: lower-case letters/digits only."""
    out = []
    for ch in unicodedata.normalize("NFKC", text).lower():
        cat = unicodedata.category(ch)
        if cat[0] in ("L", "N", "M"):
            out.append(ch)
    return out


def map_words_to_lyrics(lines, words, duration):
    """
    lines:  list of lyric line strings (what the user pasted)
    words:  list of (text, start, end) from the aligner, in order
    Returns [{"text": line, "words": [{"text", "start", "end"}]}] where every
    token of the user's lyrics gets a time, even if the aligner changed or
    dropped some text. Matching is done on normalised characters with difflib.
    """
    tok_lines = [tokenize(l) for l in lines]
    ours, our_tok = [], []          # char -> flat token index
    flat = []                       # (line_idx, token_text)
    for li, toks in enumerate(tok_lines):
        for t in toks:
            ti = len(flat)
            flat.append((li, t))
            for ch in _norm_chars(t):
                ours.append(ch)
                our_tok.append(ti)

    theirs, their_t = [], []
    for text, s, e in words:
        for ch in _norm_chars(text):
            theirs.append(ch)
            their_t.append((s, e))

    starts = [None] * len(flat)
    ends = [None] * len(flat)
    sm = difflib.SequenceMatcher(None, ours, theirs, autojunk=False)
    for a, b, size in sm.get_matching_blocks():
        for k in range(size):
            ti = our_tok[a + k]
            s, e = their_t[b + k]
            starts[ti] = s if starts[ti] is None else min(starts[ti], s)
            ends[ti] = e if ends[ti] is None else max(ends[ti], e)

    # Fill tokens the aligner didn't cover by spreading them over the gap.
    n = len(flat)
    i = 0
    while i < n:
        if starts[i] is not None:
            i += 1
            continue
        j = i
        while j < n and starts[j] is None:
            j += 1
        span = 0.5 * (j - i)  # ~half a second per unmatched word at the edges
        if i > 0 and j < n:
            lo, hi = ends[i - 1], starts[j]
        elif j < n:          # unmatched words before the first match
            hi = starts[j]
            lo = max(0.0, hi - span)
        else:                # unmatched words after the last match
            lo = ends[i - 1] if i > 0 else 0.0
            hi = lo + span
            if duration and duration > lo:
                hi = min(hi, duration)
        weights = [max(1, len(flat[k][1])) for k in range(i, j)]
        total = float(sum(weights))
        t = lo
        for k, w in zip(range(i, j), weights):
            d = (hi - lo) * w / total
            starts[k], ends[k] = t, t + d
            t += d
        i = j

    # Tidy: monotonic, no overlaps, minimum length.
    prev_end = 0.0
    for k in range(n):
        s = max(starts[k], prev_end)
        e = max(ends[k], s + 0.06)
        if k + 1 < n and starts[k + 1] is not None and e > starts[k + 1] > s:
            e = starts[k + 1]
        starts[k], ends[k] = s, e
        prev_end = e

    out = [{"text": l, "words": []} for l in lines]
    for k, (li, t) in enumerate(flat):
        out[li]["words"].append({"text": t, "start": round(starts[k], 3), "end": round(ends[k], 3)})
    return [l for l in out if l["words"]]


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
def cmd_info(args, models):
    import torch
    info = {
        "torch": torch.__version__,
        "cuda": bool(torch.cuda.is_available()),
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "whisperModel": args.whisper_model,
        "whisperReady": os.path.exists(whisper_path(models, args.whisper_model)),
        "demucsReady": os.path.exists(os.path.join(models, "demucs", args.demucs_model + ".yaml")),
    }
    emit({"type": "result", **info})


def cmd_separate(args, models):
    import numpy as np
    import torch
    stage(0, 4, "Loading the vocal separation model")
    from demucs.pretrained import get_model
    from demucs.apply import apply_model

    device = pick_device(args.device)
    from pathlib import Path
    repo = Path(models) / "demucs"
    if not (repo / (args.demucs_model + ".yaml")).exists():
        raise RuntimeError("The vocal separation model is missing (%s). Reinstall SingLine Studio or run "
                           "worker/download_models.py." % repo)
    model = get_model(args.demucs_model, repo=repo)  # local repo only, never the network
    model.eval()
    sr = model.samplerate

    stage(4, 8, "Reading the song")
    mix = decode_audio(args.ffmpeg, args.input, sr, 2)
    duration = mix.shape[1] / sr
    os.makedirs(args.outdir, exist_ok=True)

    stage(8, 94, "Separating vocals (this is the slow part)")
    wav = torch.from_numpy(mix)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        sources = apply_model(model, ((wav - mean) / std)[None], device=device,
                              shifts=1, split=True, overlap=0.25, progress=True)[0]
    sources = sources * std + mean
    vi = model.sources.index("vocals")
    vocals = sources[vi].cpu().numpy()
    instrumental = sum(sources[i] for i in range(len(model.sources)) if i != vi).cpu().numpy()

    stage(94, 100, "Saving stems")
    paths = {k: os.path.join(args.outdir, k + ".wav") for k in ("vocals", "instrumental", "mix")}
    write_wav(paths["vocals"], vocals, sr)
    write_wav(paths["instrumental"], instrumental, sr)
    write_wav(paths["mix"], mix, sr)
    progress(100, "Done")
    emit({"type": "result", **paths, "duration": round(duration, 3), "device": device})


def _load_whisper(args, models, device):
    import stable_whisper
    path = whisper_path(models, args.whisper_model)
    if not os.path.exists(path):
        raise RuntimeError("The speech model is missing (%s). Reinstall SingLine Studio or run "
                           "worker/download_models.py." % path)
    return stable_whisper.load_model(path, device=device)


def call_flexible(fn, *a, **kw):
    """Call fn, dropping keyword options this library version doesn't know."""
    while True:
        try:
            return fn(*a, **kw)
        except TypeError as e:
            msg = str(e)
            bad = [k for k in kw if k in msg]
            if not bad or ("unexpected" not in msg and "keyword" not in msg):
                raise
            for k in bad:
                kw.pop(k)


def _detect_language(model, audio_path):
    """Detect on the loudest stretch of the vocals, not the (often silent) intro."""
    import numpy as np
    import whisper
    audio = whisper.load_audio(audio_path)
    win = 16000 * 30
    if len(audio) > win:
        hop = 16000 * 5
        energies = [float(np.mean(audio[i:i + win] ** 2)) for i in range(0, len(audio) - win, hop)]
        start = int(np.argmax(energies)) * hop
        audio = audio[start:start + win]
    mel = whisper.log_mel_spectrogram(whisper.pad_or_trim(audio), model.dims.n_mels).to(model.device)
    _, probs = model.detect_language(mel)
    return max(probs, key=probs.get)


def _audio_duration(audio_path):
    import soundfile as sf
    try:
        return sf.info(audio_path).duration
    except Exception:
        return 0.0


def cmd_align(args, models):
    with open(args.lyrics, "r", encoding="utf-8-sig") as f:
        lines = [l.strip() for l in f.read().splitlines()]
    lines = [l for l in lines if l]
    if not lines:
        raise RuntimeError("There are no lyrics to sync.")

    stage(0, 12, "Loading the speech model")
    device = pick_device(args.device)
    model = _load_whisper(args, models, device)

    lang = args.lang
    if not lang or lang == "auto":
        stage(12, 16, "Detecting the language")
        lang = _detect_language(model, args.audio)

    stage(16, 80, "Syncing every word to the singing")
    import whisper
    audio = whisper.load_audio(args.audio)  # 16 kHz mono float32
    duration = len(audio) / SR16
    out = align_lines(model, audio, lines, lang)
    if out is None:
        raise RuntimeError("The aligner could not match the lyrics to this audio.")

    stage(80, 99, "Checking every line")
    out = repair_alignment(model, audio, lines, out, lang, duration)
    progress(100, "Done")
    emit({"type": "result", "language": lang, "lines": out})


# ---------------------------------------------------------------------------
# Alignment with repair. Whisper's aligner sometimes loses its place in a
# passage (a mumbled bar, an ad-lib, lyrics that differ from what's sung) and
# squeezes many words into a few hundredths of a second, or stretches one word
# over many seconds. We find those lines, re-align each bad stretch on its own
# slice of audio, and if that still fails, spread the words over the parts of
# the slice where the voice is actually audible.
# ---------------------------------------------------------------------------
SR16 = 16000


def align_lines(model, audio, lines, lang, offset=0.0):
    """Align lyric lines to a 16 kHz audio array; times are shifted by offset."""
    if len(audio) < SR16 * 0.3 or not lines:
        return None
    result = call_flexible(model.align, audio, "\n".join(lines), language=lang, verbose=False, regroup=False)
    if result is None:
        return None
    words = [(w.word, float(w.start) + offset, float(w.end) + offset) for w in result.all_words()]
    if not words:
        return None
    mapped = map_words_to_lyrics(lines, words, offset + len(audio) / SR16)
    return mapped if len(mapped) == len([l for l in lines if tokenize(l)]) else None


def line_problem(line):
    """None if the timing looks singable, else 'squeezed' or 'stretched'."""
    ws = line["words"]
    if not ws:
        return None
    span = ws[-1]["end"] - ws[0]["start"]
    n = len(ws)
    avg = span / n
    tiny = sum(1 for w in ws if w["end"] - w["start"] < 0.07)
    if (n >= 3 and tiny >= max(2, n * 0.5)) or avg < 0.11:
        return "squeezed"               # many words crammed into no time
    limit = 6.0 if n == 1 else 2.8 if n == 2 else 1.6
    if avg > limit or span > 15.0:
        return "stretched"              # the aligner sat on one word for ages
    return None


def line_ok(line):
    return line_problem(line) is None


def bad_regions(out):
    """Groups of consecutive implausible lines, as (first, last) indexes."""
    regions, i = [], 0
    while i < len(out):
        if line_ok(out[i]):
            i += 1
            continue
        j = i
        while j + 1 < len(out) and not line_ok(out[j + 1]):
            j += 1
        regions.append((i, j))
        i = j + 1
    return regions


def voiced_spans(audio, a, b, frame=0.02):
    """Time spans in [a, b] where the vocal track is clearly audible."""
    import numpy as np
    seg = audio[int(a * SR16):int(b * SR16)]
    hop = int(frame * SR16)
    if len(seg) < hop * 3:
        return [(a, b)]
    n = len(seg) // hop
    rms = np.sqrt(np.mean(seg[:n * hop].reshape(n, hop) ** 2, axis=1))
    peak = float(np.percentile(rms, 98)) or 1e-6
    thr = max(peak * 0.12, float(np.percentile(rms, 30)) * 1.5)
    on = rms > thr
    spans, k = [], 0
    while k < n:
        if not on[k]:
            k += 1
            continue
        m = k
        while m + 1 < n and (on[m + 1] or (m + 6 < n and on[m + 2:m + 6].any())):  # bridge gaps < ~0.1 s
            m += 1
        if (m - k + 1) * frame >= 0.12:
            spans.append((a + k * frame, a + (m + 1) * frame))
        k = m + 1
    return spans or [(a, b)]


def spread_over_voice(audio, region_lines, a, b):
    """Place words over the voiced parts of [a, b], weighted by word length."""
    spans = voiced_spans(audio, a, b)
    total_voiced = sum(e - s for s, e in spans)
    toks = [(li, t) for li, l in enumerate(region_lines) for t in tokenize(l)]
    weights = [max(1, len(t)) for _, t in toks]
    wsum = float(sum(weights))
    # walk along the voiced timeline
    def at(x):  # x in [0, total_voiced] -> real time
        for s, e in spans:
            if x <= e - s:
                return s + x
            x -= e - s
        return spans[-1][1]
    out = [{"text": l, "words": []} for l in region_lines]
    pos = 0.0
    for (li, t), w in zip(toks, weights):
        d = total_voiced * w / wsum
        s0, e0 = at(pos), at(pos + d * 0.92)
        out[li]["words"].append({"text": t, "start": round(s0, 3), "end": round(max(e0, s0 + 0.08), 3)})
        pos += d
    return [l for l in out if l["words"]]


def repair_alignment(model, audio, lines, out, lang, duration):
    regions = bad_regions(out)
    if not regions:
        return out
    print("repairing %d region(s): %s" % (len(regions), regions), file=sys.stderr)
    done_until = -1
    for r_i, (i, j) in enumerate(regions):
        stage_frac(r_i / max(1, len(regions)))
        if i <= done_until:
            continue
        bounds = lambda i, j: (out[i - 1]["words"][-1]["end"] + 0.05 if i > 0 else 0.0,
                               out[j + 1]["words"][0]["start"] - 0.05 if j + 1 < len(out) else duration)
        need = lambda i, j: 0.3 * sum(len(l["words"]) for l in out[i:j + 1])
        a, b = bounds(i, j)
        # Too little room: the lines around it took the time. Take in
        # neighbours (later ones first) until the slice is long enough.
        while b - a < need(i, j) and (j + 1 < len(out) or i > done_until + 1):
            if j + 1 < len(out):
                j += 1
            else:
                i -= 1
            a, b = bounds(i, j)
        done_until = j
        if b - a < 0.5:
            continue
        texts = [l["text"] for l in out[i:j + 1]]
        fixed = None
        try:
            fixed = align_lines(model, audio[int(a * SR16):int(b * SR16)], texts, lang, offset=a)
        except Exception as e:  # keep going with the fallback
            print("region re-align failed: %r" % e, file=sys.stderr)
        if fixed is None or any(not line_ok(l) for l in fixed):
            if not any(line_problem(l) == "squeezed" for l in out[i:j + 1]):
                print("region %d-%d: only stretched, keeping it" % (i, j), file=sys.stderr)
                continue
            print("region %d-%d: spreading over the voice" % (i, j), file=sys.stderr)
            fixed = spread_over_voice(audio, texts, a, b)
        if len(fixed) == j - i + 1:
            out[i:j + 1] = fixed
    # keep everything in order and non-overlapping
    prev = 0.0
    for l in out:
        for w in l["words"]:
            w["start"] = round(max(w["start"], prev), 3)
            w["end"] = round(max(w["end"], w["start"] + 0.04), 3)
            prev = w["end"]
    return out


def cmd_transcribe(args, models):
    stage(0, 12, "Loading the speech model")
    device = pick_device(args.device)
    model = _load_whisper(args, models, device)
    lang = None if (not args.lang or args.lang == "auto") else args.lang

    stage(12, 97, "Writing out the lyrics")
    kw = dict(language=lang, verbose=False, word_timestamps=True, condition_on_previous_text=False)
    if device == "cpu":
        kw["fp16"] = False
    result = call_flexible(model.transcribe, args.audio, **kw)

    stage(97, 100, "Building lines")
    lines = []
    for seg in result.segments:
        cur = []
        for w in seg.words:
            txt = w.word.strip()
            if not txt:
                continue
            # break a segment on long pauses or when it gets too long to show
            if cur and (w.start - cur[-1]["end"] > 1.2 or len(cur) >= 12):
                lines.append(cur)
                cur = []
            cur.append({"text": txt, "start": round(float(w.start), 3), "end": round(float(w.end), 3)})
        if cur:
            lines.append(cur)
    out = [{"text": " ".join(w["text"] for w in ws), "words": ws} for ws in lines]
    progress(100, "Done")
    emit({"type": "result", "language": result.language or lang, "lines": out})


def main():
    p = argparse.ArgumentParser(prog="slworker")
    p.add_argument("command", choices=["info", "separate", "align", "transcribe"])
    p.add_argument("--models", default=os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "models"))
    p.add_argument("--ffmpeg", default="ffmpeg")
    p.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    p.add_argument("--whisper-model", default=os.environ.get("SINGLINE_WHISPER_MODEL", "small"))
    p.add_argument("--demucs-model", default="htdemucs")
    p.add_argument("--input")
    p.add_argument("--outdir")
    p.add_argument("--audio")
    p.add_argument("--lyrics")
    p.add_argument("--lang", default="auto")
    args = p.parse_args()

    try:
        models = setup_env(args)
        _patch_tqdm()
        {"info": cmd_info, "separate": cmd_separate, "align": cmd_align,
         "transcribe": cmd_transcribe}[args.command](args, models)
        return 0
    except Exception as e:  # report every failure through the protocol
        traceback.print_exc()
        emit({"type": "error", "message": str(e) or e.__class__.__name__})
        return 1


if __name__ == "__main__":
    sys.exit(main())
