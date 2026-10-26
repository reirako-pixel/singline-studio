# SingLine Studio

An offline karaoke and lyric video maker for Windows 10 and 11.

Drop in a song or music video, paste the lyrics, and SingLine removes the
vocals, syncs every word to the singing, and exports a 1080p MP4 with the
words lighting up as they're sung. Everything runs on your PC: no internet,
no account, no credits.

## What it does

Two ways to start:

- **From a song**: upload the original song; the AI removes the vocals and
  syncs your lyrics.
- **Already have an instrumental or karaoke track?** Upload the instrumental,
  title and lyrics, then a vocal file (an a-cappella/vocal stem, or the
  original song) that the AI listens to for the timing. Or skip the AI and
  time the words by hand.

Features:

- **AI vocal removal** with Demucs (htdemucs). Gives you the instrumental and
  the isolated vocals as WAV files too.
- **Word-by-word lyric sync** with Whisper + stable-ts forced alignment. Paste
  your lyrics, or leave them empty and the AI writes them out.
- **Sync editor**: waveform timeline with a block per word. Drag to move,
  drag edges to trim, arrow keys to nudge by 10 ms, undo/redo, and a
  hold-to-sync mode (hold K while each word is sung).
- **Themes**: nine skins for the whole app, neon (Neon Tokyo, Synthwave,
  Cyber Lime, Electric Violet) and calm (Midnight, Aurora, Lavender Dusk,
  Ocean Calm, Sakura Night). One click copies the theme's colours to the lyrics.
- **Highlight animations**: smooth wipe, word by word, or fade in, with an
  optional neon glow on sung words.
- **Layouts**: Scrolling (lyrics roll up with the current line in focus), Karaoke (two lines with a countdown before each verse),
  Single line (for Reels/TikTok style lyric videos), and Duet (singer 1 left,
  singer 2 right, shared lines centred, a colour per singer).
- **Styling**: any installed font, size, bold, colours for unsung / sung /
  singer 2 / both, outline, shadow, title card, and a colour, image or video
  background (a music video you import becomes the background automatically).
- **Live preview** that matches the export: preview and export use the same
  layout engine, the same font files and libass-equivalent metrics.
- **Export**: H.264/AAC MP4 at 1080p or 720p, as Karaoke (instrumental) or
  Lyric video (original song).
- Works in any language Whisper supports, including Filipino/Tagalog,
  Japanese, Korean, Chinese and Thai (no-space scripts sync per character).

## System requirements

- Windows 10 or 11, 64-bit
- 8 GB RAM recommended (4 GB works for short songs)
- About 3 GB of disk space
- Optional: an NVIDIA GPU makes the AI steps several times faster (needs the GPU build)

Rough timing for a 4-minute song on a mid-range CPU: 2 to 4 minutes for vocal
removal, 1 to 2 minutes for the lyric sync. Export runs faster than real time.

## Getting the installer

Every push to `main` builds the installer on GitHub's Windows machines
(about 30 to 45 minutes) and publishes it on the repository's **Releases**
page. Download `SingLine-Studio-Setup-x.y.z.exe` from the newest release and
run it. Windows may say "Windows protected your PC" because the installer
isn't code-signed: click **More info**, then **Run anyway**.

To build with different options, open **Actions > Build Windows installer >
Run workflow** and pick a speech model (`base` for a smaller installer,
`medium` for better lyric writing) or the NVIDIA GPU build.

### Building on your own PC instead

Install [Python 3.12](https://www.python.org/downloads/windows/) (tick
"Add python.exe to PATH") and [Node.js LTS](https://nodejs.org/), then
double-click **Build SingLine Studio.bat**. The installer appears in
`release\`, and the full log is in `build-log.txt`. The same script runs from
PowerShell with options:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -WhisperModel base
```

## Running from source (development)

```powershell
# one-time: AI engine environment + models
py -3.12 -m venv worker\.venv
worker\.venv\Scripts\pip install -r worker\requirements.txt
worker\.venv\Scripts\python worker\download_models.py
# put ffmpeg.exe and ffprobe.exe in bin\ (or have them on PATH)

npm install
npm start
```

In development the app runs `worker/worker.py` with `worker\.venv` directly,
so you don't need to freeze it with PyInstaller. Set `SINGLINE_PYTHON` to use
a different Python.

`npm test` runs the layout and karaoke-script tests.

## How it works

```
Electron UI (src/)                     main process (main.js)
  ├─ lib/lyrics.js   tokenising          ├─ spawns the AI engine (slworker.exe)
  ├─ lib/layout.js   when/where lines    │     separate   → Demucs → vocals / instrumental
  ├─ lib/render.js   canvas preview      │     align      → Whisper + stable-ts → word times
  ├─ lib/ass.js      .ass karaoke file   │     transcribe → Whisper → lyrics + word times
  ├─ timeline.js     sync editor         └─ runs ffmpeg: background + libass (\kf wipe) + audio → MP4
  └─ app.js          the app
```

- The AI engine (`worker/worker.py`) is frozen with PyInstaller into
  `slworker.exe` and talks to the app with JSON lines (progress, result, error).
  Models ship inside the installer, and `TORCH_HOME` points at them, so nothing
  is downloaded at runtime.
- Lyric alignment maps the aligner's words back onto your exact lyrics with a
  character-level diff, so punctuation, spelling differences or skipped words
  never break the sync. Words it couldn't place are spread across the gap.
- libass sizes text by the font's `winAscent + winDescent`; the browser sizes
  by the em box. The font scanner reads each font's real metrics, and the
  export compensates, which is why the preview and the MP4 line up.
- Projects live in `Documents\SingLine Projects\<song>\`: `project.singline`
  (JSON, double-click to open) plus a `stems` folder.

## Troubleshooting

- **"The AI engine was not found"**: reinstall, or in development make sure
  `worker\.venv` exists.
- **The sync is off on one part**: drag those words on the timeline, or use
  hold-to-sync for that section. Running "Sync lyrics again" redoes everything.
- **Slow**: Settings shows whether a GPU is in use. The CPU build always runs on
  the CPU.
- **Text looks different in the export**: pick a font from the list (it needs a
  real font file). Fonts installed only for another user may not be visible.

## Licences

SingLine Studio's code is MIT. It bundles Demucs (MIT), OpenAI Whisper (MIT),
stable-ts (MIT), PyTorch (BSD), Electron (MIT), fontkit (MIT) and an ffmpeg
build that is GPL-licensed. Only make videos of songs you have the rights to use.
