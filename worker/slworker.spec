# PyInstaller spec: freezes worker.py into dist/slworker/slworker.exe (one folder,
# starts faster than a one-file exe and keeps torch DLLs unpacked).
#   pyinstaller --noconfirm worker/slworker.spec --distpath worker/dist --workpath worker/build
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

datas = (
    collect_data_files("whisper")          # mel filters, tokenizer vocab
    + collect_data_files("stable_whisper")
    + collect_data_files("demucs")         # model yaml definitions
)
hiddenimports = collect_submodules("demucs") + collect_submodules("stable_whisper") + ["soundfile"]

a = Analysis(
    ["worker.py"],
    pathex=[],
    datas=datas,
    hiddenimports=hiddenimports,
    # triton is a Linux-only GPU compiler whisper never needs at runtime here (saves ~900 MB)
    excludes=["matplotlib", "tkinter", "IPython", "pandas", "jupyter", "notebook", "pytest",
              "triton", "hf_xet", "torch.utils.tensorboard", "tensorboard"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="slworker",
    console=True,       # needs real stdio pipes; the app launches it hidden
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="slworker", upx=False)
