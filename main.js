// SingLine Studio - Electron main process.
// Owns the window, file dialogs, project files, the AI worker and ffmpeg.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
let win = null;
let currentJob = null; // { proc, kind }

// --------------------------------------------------------------------------
// Paths: packaged app vs. running from source
// --------------------------------------------------------------------------
function resource(...p) {
  return app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, ...p);
}

function ffmpegPath(name = 'ffmpeg') {
  const bundled = resource('bin', name + EXE);
  return fs.existsSync(bundled) ? bundled : name; // fall back to PATH in development
}

function workerCommand() {
  const frozen = resource('worker', app.isPackaged ? 'slworker' : 'dist/slworker', 'slworker' + EXE);
  if (fs.existsSync(frozen)) return { cmd: frozen, pre: [] };
  // Development: run worker.py with the worker's own virtualenv if there is one.
  const venvPy = IS_WIN
    ? path.join(__dirname, 'worker', '.venv', 'Scripts', 'python.exe')
    : path.join(__dirname, 'worker', '.venv', 'bin', 'python');
  const py = process.env.SINGLINE_PYTHON || (fs.existsSync(venvPy) ? venvPy : (IS_WIN ? 'python' : 'python3'));
  return { cmd: py, pre: [path.join(__dirname, 'worker', 'worker.py')] };
}

const projectsRoot = () => path.join(app.getPath('documents'), 'SingLine Projects');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

// --------------------------------------------------------------------------
// Window
// --------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#1E2240',
    title: 'SingLine Studio',
    icon: resource('assets', IS_WIN ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

// Open a .singline file passed on the command line (double-click in Explorer).
function projectArg(argv) {
  return argv.find((a) => a.toLowerCase().endsWith('.singline') && fs.existsSync(a)) || null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const p = projectArg(argv);
    if (p) win.webContents.send('project:open-file', p);
  });
  app.whenReady().then(() => {
    if (IS_WIN) app.setAppUserModelId('studio.singline.app');
    createWindow();
  });
  app.on('window-all-closed', () => { killJob(); app.quit(); });
}

// --------------------------------------------------------------------------
// Jobs (AI worker / ffmpeg) with progress and cancel
// --------------------------------------------------------------------------
function killJob() {
  if (!currentJob) return;
  const { proc } = currentJob;
  currentJob.cancelled = true;
  try {
    if (IS_WIN) execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    else proc.kill('SIGKILL');
  } catch { /* already gone */ }
}

function sendProgress(payload) {
  if (win) win.webContents.send('job:progress', payload);
}

// Run one worker command; resolves with its "result" message.
function runWorker(command, args, { lo = 0, hi = 100, label = '' } = {}) {
  return new Promise((resolve, reject) => {
    const { cmd, pre } = workerCommand();
    const settings = readSettings();
    const fullArgs = [...pre, command,
      '--models', resource('models'),
      '--ffmpeg', ffmpegPath(),
      '--device', settings.device || 'auto',
      ...(settings.whisperModel ? ['--whisper-model', settings.whisperModel] : []),
      ...args];
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    const ff = ffmpegPath();
    if (path.isAbsolute(ff)) env.PATH = path.dirname(ff) + path.delimiter + (env.PATH || '');

    let proc;
    try {
      proc = spawn(cmd, fullArgs, { windowsHide: true, env });
    } catch (e) {
      return reject(new Error('Could not start the AI engine: ' + e.message));
    }
    const job = { proc, kind: command };
    currentJob = job;
    let buf = '';
    let result = null;
    let errorMsg = null;
    let stderrTail = '';

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'progress') {
          sendProgress({ pct: lo + ((hi - lo) * msg.pct) / 100, msg: msg.msg, label });
        } else if (msg.type === 'result') {
          result = msg;
        } else if (msg.type === 'error') {
          errorMsg = msg.message;
        }
      }
    });
    proc.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString('utf8')).slice(-3000); });
    proc.on('error', (e) => {
      if (currentJob === job) currentJob = null;
      reject(new Error(e.code === 'ENOENT'
        ? 'The AI engine was not found. Reinstall SingLine Studio, or in development build the worker (see README).'
        : e.message));
    });
    proc.on('close', (code) => {
      if (currentJob === job) currentJob = null;
      if (job.cancelled) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (result && code === 0) return resolve(result);
      const tail = stderrTail.trim().split('\n').slice(-4).join('\n');
      reject(new Error(errorMsg || ('The AI engine stopped unexpectedly (code ' + code + ').\n' + tail)));
    });
  });
}

function writeLyricsFile(dir, lines) {
  const p = path.join(dir, 'lyrics.txt');
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  return p;
}

// Full pipeline: separate vocals, then sync the lyrics (or transcribe them).
ipcMain.handle('ai:process', async (_e, { projectDir, input, lyrics, lang }) => {
  const stemsDir = path.join(projectDir, 'stems');
  fs.mkdirSync(stemsDir, { recursive: true });
  const sep = await runWorker('separate', ['--input', input, '--outdir', stemsDir],
    { lo: 0, hi: 62, label: 'Removing vocals' });
  const hasLyrics = lyrics && lyrics.some((l) => l.trim());
  const sync = hasLyrics
    ? await runWorker('align', ['--audio', sep.vocals, '--lyrics', writeLyricsFile(projectDir, lyrics), '--lang', lang || 'auto'],
      { lo: 62, hi: 100, label: 'Syncing lyrics' })
    : await runWorker('transcribe', ['--audio', sep.vocals, '--lang', lang || 'auto'],
      { lo: 62, hi: 100, label: 'Writing out lyrics' });
  return { stems: { vocals: sep.vocals, instrumental: sep.instrumental, mix: sep.mix }, duration: sep.duration,
    device: sep.device, language: sync.language, lines: sync.lines };
});

// Re-sync only (lyrics changed, stems already exist).
ipcMain.handle('ai:align', async (_e, { projectDir, vocals, lyrics, lang }) => {
  const res = await runWorker('align', ['--audio', vocals, '--lyrics', writeLyricsFile(projectDir, lyrics), '--lang', lang || 'auto'],
    { lo: 0, hi: 100, label: 'Syncing lyrics' });
  return { language: res.language, lines: res.lines };
});

ipcMain.handle('ai:transcribe', async (_e, { vocals, lang }) => {
  const res = await runWorker('transcribe', ['--audio', vocals, '--lang', lang || 'auto'],
    { lo: 0, hi: 100, label: 'Writing out lyrics' });
  return { language: res.language, lines: res.lines };
});

ipcMain.handle('ai:info', async () => {
  try { return await runWorker('info', []); } catch (e) { return { error: e.message }; }
});

ipcMain.handle('job:cancel', () => { killJob(); return true; });

// --------------------------------------------------------------------------
// Export: burn the ASS lyrics onto the background with ffmpeg
// --------------------------------------------------------------------------
function hexToFfmpeg(hex) { return '0x' + String(hex || '#000000').replace('#', '').slice(0, 6); }

ipcMain.handle('export:video', async (_e, opts) => {
  const { ass, fontPaths = [], background, audioPath, duration, outPath, height = 1080, fps = 30 } = opts;
  const W = height === 720 ? 1280 : 1920;
  const H = height === 720 ? 720 : 1080;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'singline-'));
  const fontsDir = path.join(tmp, 'fonts');
  fs.mkdirSync(fontsDir);
  // libass loads only the chosen font, so preview and export use the same file.
  for (const fp of fontPaths) {
    if (fp && fs.existsSync(fp)) fs.copyFileSync(fp, path.join(fontsDir, path.basename(fp)));
  }
  fs.writeFileSync(path.join(tmp, 'lyrics.ass'), '\ufeff' + ass, 'utf8');

  const args = ['-hide_banner', '-y', '-nostdin'];
  if (background.type === 'image' && background.path) {
    args.push('-loop', '1', '-framerate', String(fps), '-i', background.path);
  } else if (background.type === 'video' && background.path) {
    args.push('-stream_loop', '-1', '-i', background.path);
  } else {
    args.push('-f', 'lavfi', '-i', `color=c=${hexToFfmpeg(background.color)}:s=${W}x${H}:r=${fps}`);
  }
  args.push('-i', audioPath);
  const dim = Math.max(0, Math.min(0.9, Number(background.dim) || 0));
  let vf = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps},format=yuv420p`;
  if (dim > 0 && background.type !== 'color') vf += `,drawbox=x=0:y=0:w=iw:h=ih:color=black@${dim.toFixed(2)}:t=fill`;
  vf += ',subtitles=lyrics.ass:fontsdir=fonts[v]';
  args.push('-filter_complex', vf, '-map', '[v]', '-map', '1:a:0',
    '-t', duration.toFixed(3),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', outPath);

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), args, { cwd: tmp, windowsHide: true });
    const job = { proc, kind: 'export' };
    currentJob = job;
    let errTail = '';
    let buf = '';
    proc.stdout.on('data', (c) => {
      buf += c.toString();
      const m = buf.match(/out_time_(?:us|ms)=(\d+)\s*$/m) || [...buf.matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
      if (m) {
        const sec = Number(m[1]) / 1e6;
        sendProgress({ pct: Math.min(99.5, (sec / duration) * 100), msg: 'Rendering video', label: 'Exporting' });
      }
      if (buf.length > 4000) buf = buf.slice(-1000);
    });
    proc.stderr.on('data', (c) => { errTail = (errTail + c.toString()).slice(-2000); });
    proc.on('error', (e) => { currentJob = null; reject(new Error(e.code === 'ENOENT' ? 'ffmpeg was not found.' : e.message)); });
    proc.on('close', (code) => {
      if (currentJob === job) currentJob = null;
      fs.rm(tmp, { recursive: true, force: true }, () => {});
      if (job.cancelled) { fs.rm(outPath, { force: true }, () => {}); return reject(Object.assign(new Error('Cancelled'), { cancelled: true })); }
      if (code === 0) { sendProgress({ pct: 100, msg: 'Done', label: 'Exporting' }); return resolve({ outPath }); }
      reject(new Error('Export failed:\n' + errTail.trim().split('\n').slice(-3).join('\n')));
    });
  });
});

// --------------------------------------------------------------------------
// Waveform peaks for the sync timeline (100 peaks per second)
// --------------------------------------------------------------------------
ipcMain.handle('audio:peaks', async (_e, file) => new Promise((resolve, reject) => {
  const sr = 8000;
  const per = sr / 100;
  const proc = spawn(ffmpegPath(), ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(sr), '-f', 's16le', '-'], { windowsHide: true });
  const chunks = [];
  proc.stdout.on('data', (c) => chunks.push(c));
  proc.on('error', reject);
  proc.on('close', (code) => {
    if (code !== 0) return reject(new Error('Could not read audio for the waveform.'));
    const b = Buffer.concat(chunks);
    const n = Math.floor(b.length / 2);
    const peaks = new Array(Math.ceil(n / per)).fill(0);
    for (let i = 0; i < n; i++) {
      const v = Math.abs(b.readInt16LE(i * 2)) / 32768;
      const k = (i / per) | 0;
      if (v > peaks[k]) peaks[k] = v;
    }
    resolve(peaks.map((v) => Math.round(v * 1000) / 1000));
  });
}));

ipcMain.handle('media:probe', async (_e, file) => new Promise((resolve) => {
  const probe = ffmpegPath('ffprobe');
  execFile(probe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file],
    { windowsHide: true }, (err, out) => {
      if (err) return resolve({ duration: 0, hasVideo: false, hasAudio: true });
      try {
        const j = JSON.parse(out);
        resolve({
          duration: Number(j.format && j.format.duration) || 0,
          hasVideo: (j.streams || []).some((s) => s.codec_type === 'video'),
          hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio'),
        });
      } catch { resolve({ duration: 0, hasVideo: false, hasAudio: true }); }
    });
}));

// --------------------------------------------------------------------------
// Fonts: enumerate installed + bundled font files, so the export can use the
// exact file shown in the preview.
// --------------------------------------------------------------------------
function fontDirs() {
  const dirs = [resource('assets', 'fonts')];
  if (IS_WIN) {
    dirs.push(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  } else if (process.platform === 'darwin') {
    dirs.push('/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts'));
  } else {
    dirs.push('/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.fonts'));
  }
  return dirs;
}

function walkFonts(dir, out, depth = 0) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) walkFonts(p, out, depth + 1);
    else if (/\.(ttf|otf|ttc)$/i.test(e.name)) out.push(p);
  }
}

ipcMain.handle('fonts:list', async () => {
  const cacheFile = path.join(app.getPath('userData'), 'fonts-cache.json');
  const files = [];
  fontDirs().forEach((d) => walkFonts(d, files));
  const sig = 'v3:' + files.length + ':' + files.join('|').length;
  try {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cache.sig === sig) return cache.fonts;
  } catch { /* rebuild */ }

  const fontkit = require('fontkit');
  const families = new Map(); // family -> { family, path, boldPath, score, metrics }
  for (const file of files) {
    let f;
    try { f = fontkit.openSync(file); } catch { continue; }
    const face = f.fonts ? f.fonts[0] : f;
    if (!face || !face.familyName) continue;
    const family = String(face.familyName).trim();
    const sub = String(face.subfamilyName || '').toLowerCase().trim();
    const entry = families.get(family) || { family, path: null, boldPath: null, score: -1, metrics: null };
    families.set(family, entry);
    // Remember the real Bold file so "Bold" looks the same in preview and export.
    if (sub === 'bold') { entry.boldPath = file; if (entry.path) continue; }
    // Prefer the Regular face of each family for the main file.
    const score = sub === 'regular' ? 3 : sub === 'normal' || sub === 'book' ? 2 : sub.includes('italic') ? 0 : 1;
    if (score > entry.score) {
      // Vertical metrics as fractions of the em. libass sizes text by
      // winAscent + winDescent, so the UI uses these to match it exactly.
      const upm = face.unitsPerEm || 1000;
      const os2 = face['OS/2'];
      let a = os2 && os2.winAscent ? os2.winAscent / upm : (face.ascent || upm * 0.9) / upm;
      let d = os2 && os2.winDescent ? os2.winDescent / upm : Math.abs(face.descent || upm * 0.25) / upm;
      if (!(a > 0.3 && a < 3)) a = 0.95;
      if (!(d >= 0 && d < 2)) d = 0.25;
      Object.assign(entry, { path: file, score, metrics: { a: +a.toFixed(4), d: +d.toFixed(4) },
        bundled: file.startsWith(resource('assets', 'fonts')) });
    }
  }
  const fonts = [...families.values()]
    .filter((f) => f.path && !/^(marlett|symbol|webdings|wingdings)/i.test(f.family))
    .sort((a, b) => (b.bundled - a.bundled) || a.family.localeCompare(b.family))
    .map(({ family, path: p, boldPath, bundled, metrics }) => ({ family, path: p, boldPath: boldPath !== p ? boldPath : null, bundled: !!bundled, metrics }));
  try { fs.writeFileSync(cacheFile, JSON.stringify({ sig, fonts })); } catch { /* not critical */ }
  return fonts;
});

// --------------------------------------------------------------------------
// Projects: each project is a folder in Documents\SingLine Projects holding
// project.singline (JSON) and the separated stems.
// --------------------------------------------------------------------------
function safeName(s) {
  return String(s || 'Untitled').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Untitled';
}

ipcMain.handle('project:new-dir', async (_e, title) => {
  const root = projectsRoot();
  fs.mkdirSync(root, { recursive: true });
  let dir = path.join(root, safeName(title));
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, safeName(title) + ' (' + i + ')');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
});

function rememberRecent(file, title) {
  const s = readSettings();
  s.recent = [{ file, title, at: Date.now() }, ...(s.recent || []).filter((r) => r.file !== file)].slice(0, 12);
  writeSettings(s);
}

ipcMain.handle('project:save', async (_e, { dir, project }) => {
  const file = path.join(dir, 'project.singline');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(project, null, 1), 'utf8');
  fs.renameSync(tmp, file);
  rememberRecent(file, project.title);
  return file;
});

ipcMain.handle('project:load', async (_e, file) => {
  const project = JSON.parse(fs.readFileSync(file, 'utf8'));
  rememberRecent(file, project.title);
  return { dir: path.dirname(file), project };
});

ipcMain.handle('project:recent', async () => (readSettings().recent || []).filter((r) => fs.existsSync(r.file)));
ipcMain.handle('project:pending-open', async () => projectArg(process.argv));

ipcMain.handle('settings:get', async () => readSettings());
ipcMain.handle('settings:set', async (_e, patch) => { const s = { ...readSettings(), ...patch }; writeSettings(s); return s; });

// --------------------------------------------------------------------------
// Dialogs and shell helpers
// --------------------------------------------------------------------------
const FILTERS = {
  song: [{ name: 'Songs and music videos', extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'mp4', 'mkv', 'mov', 'webm', 'avi'] }],
  image: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
  video: [{ name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'] }],
  project: [{ name: 'SingLine projects', extensions: ['singline'] }],
  lyrics: [{ name: 'Lyrics', extensions: ['txt', 'lrc'] }],
};

ipcMain.handle('dialog:open', async (_e, kind) => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: FILTERS[kind] || [],
    defaultPath: kind === 'project' ? projectsRoot() : undefined,
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('dialog:save-video', async (_e, suggested) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('videos'), safeName(suggested) + '.mp4'),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('file:read-text', async (_e, p) => fs.readFileSync(p, 'utf8').replace(/^\ufeff/, ''));
ipcMain.handle('shell:show', async (_e, p) => { shell.showItemInFolder(p); return true; });
ipcMain.handle('shell:open', async (_e, p) => shell.openPath(p));
ipcMain.handle('app:info', async () => ({ version: app.getVersion(), platform: process.platform, packaged: app.isPackaged }));
