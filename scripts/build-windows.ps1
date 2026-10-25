<#
  Build the SingLine Studio Windows installer, start to finish.

  Run from the project folder in PowerShell:
      powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1

  Options:
      -WhisperModel small   Speech model: tiny | base | small (default) | medium
                            Bigger = more accurate lyric writing, bigger installer.
      -Gpu                  Build with NVIDIA CUDA support (much larger installer).
      -SkipWorker           Reuse an already built AI engine (worker\dist).

  Needs: Python 3.12 (python.org, tick "Add to PATH"), Node.js 20+, ~10 GB free disk,
  and internet during the build only. The finished app runs fully offline.
  Output: release\SingLine-Studio-Setup-<version>.exe
#>
param(
  [string]$WhisperModel = "small",
  [switch]$Gpu,
  [switch]$SkipWorker
)
# Continue, not Stop: in Windows PowerShell 5.1, Stop turns any warning a
# program prints on stderr into a fatal error. Exit codes are checked instead.
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"   # makes Invoke-WebRequest much faster
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

try {

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Yellow }
function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd was not found. $hint" }
}

# ---------------------------------------------------------------- Python
Step "Checking tools"
$pyExe = $null; $pyArgs = @()
if (Get-Command py -ErrorAction SilentlyContinue) {
  foreach ($v in "3.12", "3.11", "3.13") {
    & py "-$v" -c "import sys" 2>$null
    if ($LASTEXITCODE -eq 0) { $pyExe = "py"; $pyArgs = @("-$v"); break }
  }
}
if (-not $pyExe) { Need python "Install Python 3.12 from https://www.python.org/downloads/windows/"; $pyExe = "python" }
Need node "Install Node.js LTS from https://nodejs.org/"
Need npm  "Install Node.js LTS from https://nodejs.org/"
& $pyExe @pyArgs --version

if (-not $SkipWorker) {
  # -------------------------------------------------------------- AI engine
  Step "Creating the AI engine's Python environment"
  if (-not (Test-Path "worker\.venv")) { & $pyExe @pyArgs -m venv worker\.venv }
  $vpy = "worker\.venv\Scripts\python.exe"
  if (-not (Test-Path $vpy)) { throw "Could not create the Python environment." }
  & $vpy -m pip install --upgrade pip wheel
  if ($LASTEXITCODE -ne 0) { throw "Could not update pip" }

  $req = Get-Content worker\requirements.txt
  if ($Gpu) {
    Step "Installing packages (NVIDIA GPU build)"
    $req = $req -replace "whl/cpu", "whl/cu126"
  } else {
    Step "Installing packages (CPU build)"
  }
  $reqFile = Join-Path $env:TEMP "singline-req.txt"
  $req | Set-Content $reqFile
  & $vpy -m pip install -r $reqFile
  if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

  Step "Downloading AI models (Demucs + Whisper $WhisperModel)"
  & $vpy worker\download_models.py --whisper $WhisperModel --out models
  if ($LASTEXITCODE -ne 0) { throw "Model download failed" }

  Step "Freezing the AI engine with PyInstaller"
  Push-Location worker
  & .venv\Scripts\pyinstaller.exe --noconfirm slworker.spec --distpath dist --workpath build
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { throw "PyInstaller failed" }

  Step "Testing the frozen AI engine"
  $info = (& worker\dist\slworker\slworker.exe info --models models --whisper-model $WhisperModel) | Out-String
  Write-Host $info
  if ($info -notmatch '"whisperReady": true' -or $info -notmatch '"demucsReady": true') { throw "The frozen engine cannot see the models." }
}

# ---------------------------------------------------------------- ffmpeg
if (-not (Test-Path "bin\ffmpeg.exe")) {
  Step "Downloading ffmpeg (with libass for the lyric rendering)"
  New-Item -ItemType Directory -Force bin | Out-Null
  $zip = Join-Path $env:TEMP "ffmpeg-win64.zip"
  $url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
  Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
  if (-not (Test-Path $zip)) { throw "ffmpeg download failed" }
  $tmp = Join-Path $env:TEMP "ffmpeg-extract"
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip $tmp
  Get-ChildItem $tmp -Recurse -Include ffmpeg.exe, ffprobe.exe | Copy-Item -Destination bin
  if (-not (Test-Path "bin\ffmpeg.exe")) { throw "ffmpeg.exe was not found in the download" }
}
$filters = & bin\ffmpeg.exe -hide_banner -filters 2>$null | Out-String
if ($filters -notmatch '\ssubtitles\s') { throw "This ffmpeg has no libass support." }

# ---------------------------------------------------------------- app
Step "Installing app dependencies"
if (Test-Path package-lock.json) { npm ci } else { npm install }
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

Step "Running tests"
npm test
if ($LASTEXITCODE -ne 0) { throw "Tests failed" }

Step "Building the installer"
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"   # no code-signing certificate
npx electron-builder --win --x64 --publish never
if ($LASTEXITCODE -ne 0) {
  # Usually "Cannot create symbolic link" while unpacking the signing tools
  # (needs Developer Mode or admin). Build again without editing the exe.
  Write-Host "Retrying without exe signing/editing (the app still works; the .exe may show a default icon)" -ForegroundColor Yellow
  npx electron-builder --win --x64 --publish never "-c.win.signAndEditExecutable=false"
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }
}

$exe = Get-ChildItem release\*.exe | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exe) { throw "No installer was produced" }
Write-Host "`nBUILD OK: $($exe.FullName)  ($([math]::Round($exe.Length / 1MB)) MB)" -ForegroundColor Green

} catch {
  Write-Host "`nBUILD FAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
exit 0
