// SingLine Studio - UI logic.
// Screens: start -> setup wizard (song flow or instrumental flow) -> editor.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const L = window.SLLyrics;
  const Lay = window.SLLayout;
  const sl = window.sl;

  const LANGS = [
    ['auto', 'Detect automatically'], ['en', 'English'], ['tl', 'Filipino / Tagalog'], ['es', 'Spanish'],
    ['pt', 'Portuguese'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['ja', 'Japanese'],
    ['ko', 'Korean'], ['zh', 'Chinese'], ['id', 'Indonesian'], ['ms', 'Malay'], ['vi', 'Vietnamese'],
    ['th', 'Thai'], ['hi', 'Hindi'], ['ru', 'Russian'], ['ar', 'Arabic'], ['tr', 'Turkish'],
    ['nl', 'Dutch'], ['pl', 'Polish'], ['uk', 'Ukrainian'], ['sv', 'Swedish'],
  ];
  const AUDIO_EXT = /\.(mp3|wav|flac|aac|m4a|ogg|opus|wma|mp4|mkv|mov|webm|avi)$/i;
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];

  const S = {
    dir: null, p: null, scene: null, page: null,
    fonts: [], fontAlias: 'Segoe UI', loadedFonts: new Map(),
    selected: null, undo: [], redo: [], undoKey: null, undoAt: 0,
    monitor: 'inst', saveTimer: null, needsDraw: true, tap: null,
    media: { image: null, video: null }, currentLine: -1, lastJob: null,
  };

  const audio = $('#audio');
  const bgVideo = $('#bgVideo');
  const preview = $('#preview');
  const pctx = preview.getContext('2d');
  const measure = window.SLRender.makeMeasure(() => S.fontAlias);

  function newProject(mode) {
    return {
      version: 2, mode, title: '', artist: '', source: '', sourceHasVideo: false,
      vocalFile: '', vocalIsFullSong: false,
      stems: null, duration: 0, language: 'auto', lyricsText: '', lines: [],
      style: Lay.withDefaults({}), exportOpts: { type: 'karaoke', height: 1080 }, created: Date.now(),
    };
  }

  // ================================================================= helpers
  let toastTimer;
  function toast(msg, isError = false, ms = 4200) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), isError ? Math.max(ms, 7000) : ms);
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) &&
    !(el.tagName === 'INPUT' && /^(range|checkbox|color|button)$/.test(el.type));
  // Errors from the main process: strip the IPC prefix and pull out the log path.
  function parseErr(e) {
    let m = String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    let log = null;
    const lm = m.match(/\s*\[log:(.+)\]\s*$/);
    if (lm) { log = lm[1]; m = m.slice(0, lm.index); }
    return { message: m.trim(), log, cancelled: /^Cancelled$/.test(m.trim()) };
  }
  function show(screen) {
    $('#welcome').hidden = screen !== 'welcome';
    $('#wizard').hidden = screen !== 'wizard';
    $('#app').hidden = screen !== 'app';
  }

  // ================================================================= saving
  function markDirty() {
    if (!S.dir) return;
    $('#saveState').textContent = 'Saving…';
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(saveNow, 700);
  }
  async function saveNow() {
    if (!S.dir || !S.p) return;
    clearTimeout(S.saveTimer);
    S.saveTimer = null;
    try {
      await sl.saveProject(S.dir, S.p);
      $('#saveState').textContent = '✓ Saved';
    } catch (e) {
      $('#saveState').textContent = 'Not saved';
      toast('Could not save the project: ' + parseErr(e).message, true);
    }
  }
  async function ensureDir(nameHint) {
    if (!S.dir) S.dir = await sl.newProjectDir(nameHint || 'Untitled');
    return S.dir;
  }

  // ================================================================= start screen
  async function showWelcome() {
    if (S.p) await saveNow();
    pause();
    show('welcome');
    const recent = await sl.recentProjects();
    $('#recentWrap').hidden = !recent.length;
    $('#recentList').innerHTML = '';
    for (const r of recent) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.innerHTML = '<span></span><span class="when"></span>';
      b.firstChild.textContent = r.title || sl.basename(r.file.replace(/[\\/]project\.singline$/, ''));
      b.lastChild.textContent = new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      b.onclick = () => openProject(r.file);
      li.appendChild(b);
      $('#recentList').appendChild(li);
    }
  }

  // ================================================================= setup wizard
  const WZ_STEPS = {
    song: [['source', 'Song and lyrics'], ['work', 'Remove vocals and sync']],
    inst: [['source', 'Instrumental and lyrics'], ['vocals', 'Vocals'], ['work', 'Sync']],
  };

  function startWizard(mode) {
    pause();
    S.dir = null;
    S.p = newProject(mode);
    S.undo = []; S.redo = []; S.selected = null;
    resetUpload('src'); resetUpload('voc');
    $('#wzTitle').value = ''; $('#wzArtist').value = ''; $('#wzLang').value = 'auto'; $('#wzLyrics').value = '';
    $('#vocFullSong').checked = false;
    const inst = mode === 'inst';
    $('#srcHeading').textContent = inst ? 'Your instrumental and lyrics' : 'Your song and lyrics';
    $('#srcLede').textContent = inst
      ? 'Upload your instrumental audio file, give it a title and paste the lyrics.'
      : 'Upload the original song (or its music video), give it a title and paste the lyrics.';
    $('#srcDropMain').textContent = inst ? 'Drop your instrumental here' : 'Drop the song here';
    $('#wzLyricsHint').textContent = inst
      ? 'Leave it empty and the AI writes the lyrics out from the vocal file in the next step.'
      : 'Leave it empty and the AI writes the lyrics out from the singing.';
    $('#wzSaveContinue').textContent = 'Save and continue';
    updateWizardButtons();
    show('wizard');
    gotoPage('source');
  }

  function gotoPage(page) {
    S.page = page;
    $$('.wz-page').forEach((p) => p.classList.toggle('active', p.dataset.page === page));
    const steps = WZ_STEPS[S.p.mode] || WZ_STEPS.song;
    const idx = steps.findIndex(([k]) => k === page);
    $('#wzSteps').innerHTML = steps.map(([, name], i) =>
      `<li class="${i < idx ? 'done' : i === idx ? 'active' : ''}"><b>${i + 1}</b>${name}</li>`).join('');
    $('#wzBack').textContent = page === 'source' ? 'Cancel' : 'Back';
    $('#wzBack').disabled = page === 'work'; // re-enabled if the job fails
    if (page === 'work') { $('#workError').hidden = true; $('.work').classList.remove('failed'); }
  }

  function resetUpload(k) {
    $(`#${k}Upload`).hidden = true;
    $(`#${k}Upload`).classList.remove('done');
    $(`#drop${k === 'src' ? 'Source' : 'Vocals'}`).hidden = false;
    $(`#${k}Bar`).style.width = '0%';
    $(`#${k}Pct`).textContent = '0%';
    $(`#${k}Meta`).textContent = '';
    $(`#${k}Error`).textContent = '';
  }

  // Copy a chosen file into the project folder, showing progress.
  async function importInto(k, path, opts) {
    const box = $(`#${k}Upload`);
    $(`#drop${k === 'src' ? 'Source' : 'Vocals'}`).hidden = true;
    box.hidden = false;
    box.classList.remove('done');
    $(`#${k}Name`).textContent = sl.basename(path);
    $(`#${k}Meta`).textContent = 'Uploading into the project folder…';
    $(`#${k}Error`).textContent = '';
    const off = sl.onImportProgress((p) => {
      $(`#${k}Bar`).style.width = p.pct + '%';
      $(`#${k}Pct`).textContent = Math.floor(p.pct) + '%';
    });
    try {
      const dst = await sl.importMedia({ src: path, projectDir: S.dir, ...opts });
      const info = await sl.probe(dst);
      if (!info.hasAudio) throw new Error('That file has no audio track.');
      box.classList.add('done');
      $(`#${k}Bar`).style.width = '100%';
      $(`#${k}Pct`).textContent = '100%';
      return { path: dst, info };
    } catch (e) {
      resetUpload(k);
      $(`#${k}Error`).textContent = parseErr(e).message;
      return null;
    } finally {
      off();
    }
  }

  function guessTitle(path) {
    const name = sl.basename(path).replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
    const m = name.match(/^(.+?)\s+-\s+(.+)$/);
    return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: name };
  }

  async function chooseSource(path) {
    if (!path) return;
    if (!AUDIO_EXT.test(path)) { $('#srcError').textContent = 'That file type is not supported. Use an audio file or a video.'; return; }
    const g = guessTitle(path);
    if (!$('#wzTitle').value.trim()) $('#wzTitle').value = g.title;
    if (!$('#wzArtist').value.trim()) $('#wzArtist').value = g.artist;
    await ensureDir($('#wzTitle').value.trim() || g.title);
    const r = await importInto('src', path, { sub: 'media' });
    if (!r) return;
    const p = S.p;
    p.source = r.path;
    p.sourceHasVideo = r.info.hasVideo;
    p.duration = r.info.duration;
    p.stems = null;
    $('#srcMeta').textContent = `${L.fmtTime(r.info.duration, false)} long${r.info.hasVideo ? ', with video' : ''}. Saved in the project folder.`;
    if (r.info.hasVideo && p.style.bg.type === 'color') p.style.bg = { ...p.style.bg, type: 'video', path: r.path, dim: 0.45 };
    updateWizardButtons();
  }

  async function chooseVocals(path) {
    if (!path) return;
    if (!AUDIO_EXT.test(path)) { $('#vocError').textContent = 'That file type is not supported.'; return; }
    const r = await importInto('voc', path, { sub: 'media', name: 'vocals - ' + sl.basename(path).replace(/\.[^.]+$/, '') });
    if (!r) return;
    S.p.vocalFile = r.path;
    S.p.stems = null;
    const diff = Math.abs((r.info.duration || 0) - (S.p.duration || 0));
    $('#vocMeta').textContent = `${L.fmtTime(r.info.duration, false)} long.` +
      (diff > 3 ? ` The instrumental is ${L.fmtTime(S.p.duration, false)}. Make sure both start at the same moment, or the words will be off.` : ' Same length as the instrumental.');
    updateWizardButtons();
  }

  function wizardLyrics() { return $('#wzLyrics').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean); }

  function updateWizardButtons() {
    const n = wizardLyrics().length;
    $('#wzCount').textContent = n ? n + (n === 1 ? ' line' : ' lines') : '';
    $('#wzSaveContinue').disabled = !(S.p && S.p.source && $('#wzTitle').value.trim());
    $('#wzSync').disabled = !(S.p && S.p.vocalFile);
    $('#wzSync').textContent = n ? 'Sync lyrics' : 'Write out and sync lyrics';
    $('#wzManual').disabled = !n;
  }

  function collectWizard() {
    const p = S.p;
    p.title = $('#wzTitle').value.trim();
    p.artist = $('#wzArtist').value.trim();
    p.language = $('#wzLang').value;
    p.lyricsText = $('#wzLyrics').value;
    p.vocalIsFullSong = $('#vocFullSong').checked;
  }

  async function saveAndContinue() {
    collectWizard();
    if (!S.p.title) { $('#srcError').textContent = 'Give the video a title.'; return; }
    if (S.p.mode === 'song' && !S.p.lyricsText.trim()) {
      // fine: the AI writes them out
    }
    await saveNow();
    if (S.p.mode === 'inst') gotoPage('vocals');
    else runJob('song');
  }

  // Run the AI from the wizard's progress page.
  let offWork = null;
  async function runJob(kind) {
    collectWizard();
    await saveNow();
    S.lastJob = kind;
    gotoPage('work');
    $('#workLabel').textContent = kind === 'song' ? 'Removing vocals' : 'Syncing lyrics';
    $('#workMsg').textContent = 'Starting…';
    $('#workBar').style.width = '0%';
    $('#workPct').textContent = '0%';
    $('#workCancel').hidden = false;
    if (offWork) offWork();
    offWork = sl.onProgress((pr) => {
      if (pr.label) $('#workLabel').textContent = pr.label;
      if (pr.msg) $('#workMsg').textContent = pr.msg;
      const pct = clamp(pr.pct || 0, 0, 100);
      $('#workBar').style.width = pct + '%';
      $('#workPct').textContent = Math.floor(pct) + '%';
    });
    const p = S.p;
    const lyrics = wizardLyrics();
    try {
      let res;
      if (kind === 'song') {
        res = await sl.process({ projectDir: S.dir, input: p.source, lyrics, lang: p.language });
        p.duration = res.duration || p.duration;
      } else {
        res = await sl.syncVocals({ projectDir: S.dir, instrumental: p.source, vocalFile: p.vocalFile,
          isFullSong: p.vocalIsFullSong, lyrics, lang: p.language });
      }
      p.stems = res.stems;
      p.lines = L.fromWorker(res.lines);
      if (res.language && p.language === 'auto') p.detectedLanguage = res.language;
      if (!lyrics.length) p.lyricsText = p.lines.map(L.lineText).join('\n');
      await saveNow();
      openEditor({ toast: `Synced ${p.lines.length} lines. Play it back and drag any word that is off.` });
    } catch (e) {
      const err = parseErr(e);
      if (err.cancelled) { gotoPage(kind === 'song' ? 'source' : 'vocals'); toast('Cancelled.'); return; }
      showWorkError(err);
    } finally {
      if (offWork) { offWork(); offWork = null; }
    }
  }

  function showWorkError(err) {
    $('.work').classList.add('failed');
    $('#workCancel').hidden = true;
    $('#workLabel').textContent = 'That didn\'t work';
    $('#workMsg').textContent = '';
    $('#workError').hidden = false;
    $('#workErrorMsg').textContent = err.message + (err.log ? '\n\nThe full details are in the error log.' : '');
    $('#workLog').hidden = !err.log;
    $('#workLog').onclick = () => sl.showInFolder(err.log);
    $('#workManual').disabled = !wizardLyrics().length;
    $('#wzBack').disabled = false;
  }

  // Lyrics without AI: spread them over the song so they can be timed by hand.
  async function continueManually() {
    collectWizard();
    const texts = wizardLyrics();
    if (!texts.length) { toast('Paste the lyrics first, so there is something to sync.', true); return; }
    const p = S.p;
    if (p.mode === 'inst') {
      p.stems = { instrumental: p.source, vocals: p.vocalFile || null, mix: null };
    } else {
      p.stems = null;
    }
    const d = p.duration || 180;
    p.lines = L.untimedLines(texts, Math.min(5, d * 0.05), Math.max(d * 0.5, d - 5));
    await saveNow();
    openEditor({ toast: 'Lyrics placed evenly. Turn on Hold-to-sync, play, and hold K while each word is sung.' });
  }

  // ================================================================= projects
  async function openProject(file) {
    try {
      const { dir, project } = await sl.loadProject(file);
      S.dir = dir;
      S.p = { ...newProject(project.mode || 'song'), ...project };
      S.p.mode = project.mode || 'song';
      S.p.style = Lay.withDefaults(project.style);
      S.p.exportOpts = { type: 'karaoke', height: 1080, ...(project.exportOpts || {}) };
      S.undo = []; S.redo = []; S.selected = null;
      if (!S.p.lines.length) {
        // never got past setup: reopen the wizard with what's there
        startWizardFrom(S.p);
        return;
      }
      openEditor({});
    } catch (e) {
      toast('Could not open that project: ' + parseErr(e).message, true);
    }
  }

  function startWizardFrom(p) {
    const dir = S.dir;
    const saved = p;
    startWizard(p.mode);
    S.dir = dir;
    S.p = saved;
    $('#wzTitle').value = p.title || '';
    $('#wzArtist').value = p.artist || '';
    $('#wzLang').value = p.language || 'auto';
    $('#wzLyrics').value = p.lyricsText || '';
    $('#vocFullSong').checked = !!p.vocalIsFullSong;
    if (p.source) {
      $('#dropSource').hidden = true; $('#srcUpload').hidden = false; $('#srcUpload').classList.add('done');
      $('#srcName').textContent = sl.basename(p.source); $('#srcBar').style.width = '100%'; $('#srcPct').textContent = '100%';
      $('#srcMeta').textContent = `${L.fmtTime(p.duration, false)} long.`;
    }
    if (p.vocalFile) {
      $('#dropVocals').hidden = true; $('#vocUpload').hidden = false; $('#vocUpload').classList.add('done');
      $('#vocName').textContent = sl.basename(p.vocalFile); $('#vocBar').style.width = '100%'; $('#vocPct').textContent = '100%';
    }
    updateWizardButtons();
  }

  // ================================================================= editor
  async function openEditor({ toast: msg }) {
    show('app');
    S.selected = S.p.lines.length ? { li: 0, wi: 0 } : null;
    timeline.sel = S.selected;
    fillAll();
    setAudioSource();
    loadBgMedia();
    timeline.setPeaks(null);
    const vox = S.p.stems && S.p.stems.vocals;
    if (vox) sl.peaks(vox).then((pk) => timeline.setPeaks(pk)).catch(() => {});
    await resolveFont();
    rebuild();
    fitPreview();
    timeline.resize();
    $('#saveState').textContent = '✓ Saved';
    if (S.p.lines.length) seek(Math.max(0, L.lineStart(S.p.lines[0]) - 2));
    if (msg) toast(msg);
  }

  function rebuild() {
    if (!S.p) return;
    S.scene = Lay.buildScene(S.p, measure);
    if (preview.width !== S.scene.W || preview.height !== S.scene.H) {
      preview.width = S.scene.W;
      preview.height = S.scene.H;
      fitPreview();
    }
    S.needsDraw = true;
  }

  function fitPreview() {
    const st = $('#stage');
    const r = st.getBoundingClientRect();
    if (!r.width || !r.height || !S.scene) return;
    const ar = S.scene.W / S.scene.H;
    let w = r.width;
    let h = w / ar;
    if (h > r.height) { h = r.height; w = h * ar; }
    preview.style.width = Math.floor(w) + 'px';
    preview.style.height = Math.floor(h) + 'px';
    S.needsDraw = true;
  }

  const getTime = () => (audio.src ? audio.currentTime || 0 : 0);
  const duration = () => (S.p && (S.p.duration || audio.duration)) || 0;

  // ---------------------------------------------------------------- fonts
  async function initFonts() {
    try { S.fonts = await sl.fonts(); } catch { S.fonts = []; }
    $('#fontList').innerHTML = S.fonts.map((f) => `<option value="${escapeAttr(f.family)}">`).join('');
    $('#inFont').placeholder = S.fonts.length ? 'Type to search ' + S.fonts.length + ' fonts' : 'No fonts found';
    if (S.p && !$('#app').hidden) await resolveFont();
  }
  const fontRef = (f) => ({ family: f.family, path: f.path, boldPath: f.boldPath || null, metrics: f.metrics });
  async function resolveFont() {
    const st = S.p.style;
    if (S.fonts.length) {
      const want = [st.font.family, 'Segoe UI', 'Arial', 'DejaVu Sans'];
      const f = want.map((w) => S.fonts.find((x) => x.family.toLowerCase() === String(w).toLowerCase())).find(Boolean) || S.fonts[0];
      if (f) {
        const before = JSON.stringify(st.font);
        st.font = fontRef(f);
        if (JSON.stringify(st.font) !== before && S.dir) markDirty();
      }
    }
    $('#inFont').value = st.font.family;
    await applyFont(st.font);
  }
  async function applyFont(font) {
    if (!font || !font.path) { S.fontAlias = (font && font.family) || 'Segoe UI'; rebuild(); return; }
    let alias = S.loadedFonts.get(font.path);
    if (!alias) {
      alias = 'slf' + S.loadedFonts.size;
      try {
        const faces = [new FontFace(alias, `url("${sl.fileUrl(font.path)}")`, { weight: '400' })];
        if (font.boldPath) faces.push(new FontFace(alias, `url("${sl.fileUrl(font.boldPath)}")`, { weight: '700' }));
        for (const face of faces) { await face.load(); document.fonts.add(face); }
      } catch {
        alias = font.family;
      }
      S.loadedFonts.set(font.path, alias);
    }
    S.fontAlias = alias;
    rebuild();
  }

  // ---------------------------------------------------------------- undo (lines + look)
  function snapshot() {
    const p = S.p;
    return JSON.stringify({ lines: p.lines, style: p.style, title: p.title, artist: p.artist });
  }
  // Coalesce rapid edits of the same kind (slider drags, nudges) into one step.
  function pushUndo(key) {
    const now = performance.now();
    if (key && key === S.undoKey && now - S.undoAt < 1000) { S.undoAt = now; return; }
    S.undoKey = key || null;
    S.undoAt = now;
    S.undo.push(snapshot());
    if (S.undo.length > 200) S.undo.shift();
    S.redo = [];
    updateUndoButtons();
  }
  function undo(redo = false) {
    const from = redo ? S.redo : S.undo;
    const to = redo ? S.undo : S.redo;
    if (!from.length) return;
    to.push(snapshot());
    const s = JSON.parse(from.pop());
    Object.assign(S.p, s);
    S.undoKey = null;
    S.selected = null; timeline.sel = null;
    fillAll(); applyFont(S.p.style.font); loadBgMedia(); rebuild(); markDirty();
    updateUndoButtons();
  }
  function updateUndoButtons() {
    $('#btnUndo').disabled = !S.undo.length;
    $('#btnRedo').disabled = !S.redo.length;
  }

  // ---------------------------------------------------------------- lyrics section
  function renderLineList() {
    const ol = $('#lineList');
    ol.innerHTML = '';
    S.p.lines.forEach((line, i) => {
      const li = document.createElement('li');
      li.dataset.i = i;
      li.innerHTML = `<span class="t"></span><span class="txt"></span><span class="singer" title="Who sings this line">
        <button data-v="1" title="Singer 1">1</button><button data-v="2" title="Singer 2">2</button><button data-v="3" title="Both">B</button></span>`;
      li.querySelector('.t').textContent = L.fmtTime(L.lineStart(line));
      li.querySelector('.txt').textContent = L.lineText(line);
      li.querySelectorAll('.singer button').forEach((b) => {
        b.classList.toggle('on', Number(b.dataset.v) === (line.singer || 1));
        b.onclick = (e) => {
          e.stopPropagation();
          pushUndo();
          line.singer = Number(b.dataset.v);
          renderLineList(); rebuild(); markDirty();
        };
      });
      li.onclick = () => {
        S.selected = { li: i, wi: 0 };
        timeline.sel = S.selected;
        seek(Math.max(0, L.lineStart(line) - 0.6));
        timeline.reveal(L.lineStart(line));
      };
      const txt = li.querySelector('.txt');
      txt.ondblclick = (e) => { e.stopPropagation(); editLineText(txt, i); };
      ol.appendChild(li);
    });
    S.currentLine = -1;
  }

  function editLineText(el, i) {
    const before = el.textContent;
    el.contentEditable = 'true';
    el.focus();
    document.getSelection().selectAllChildren(el);
    const finish = (commit) => {
      el.contentEditable = 'false';
      el.onkeydown = null; el.onblur = null;
      const text = el.textContent.trim();
      if (!commit || text === before) { el.textContent = before; return; }
      pushUndo();
      if (!text) S.p.lines.splice(i, 1);
      else S.p.lines[i] = L.retimeLine(S.p.lines[i], text);
      L.normalize(S.p.lines);
      S.p.lyricsText = S.p.lines.map(L.lineText).join('\n');
      S.selected = null; timeline.sel = null;
      renderLineList(); rebuild(); markDirty();
    };
    el.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation();
    };
    el.onblur = () => finish(true);
  }

  function highlightCurrentLine(t) {
    let cur = -1;
    S.p.lines.forEach((l, i) => { if (t >= L.lineStart(l) - 0.2) cur = i; });
    if (cur === S.currentLine) return;
    S.currentLine = cur;
    $$('#lineList li').forEach((li) => li.classList.toggle('current', Number(li.dataset.i) === cur));
    const el = $(`#lineList li[data-i="${cur}"]`);
    if (el && !audio.paused) el.scrollIntoView({ block: 'nearest' });
  }

  // Re-sync with the AI from the editor (after lyrics edits).
  async function resync(texts) {
    const p = S.p;
    const vocals = p.stems && p.stems.vocals;
    if (!vocals) {
      // no vocal track: just re-place the lyrics over the same span
      pushUndo();
      const from = p.lines.length ? L.lineStart(p.lines[0]) : 5;
      const to = p.lines.length ? L.lineEnd(p.lines[p.lines.length - 1]) : (duration() - 5);
      p.lines = L.untimedLines(texts, from, Math.max(from + texts.length, to));
      p.lyricsText = texts.join('\n');
      afterLinesChanged('Lyrics updated. There is no vocal track to sync to, so time them by hand.');
      return;
    }
    pause();
    showBusy('Syncing lyrics');
    try {
      const res = await sl.align({ projectDir: S.dir, vocals, lyrics: texts, lang: p.language });
      pushUndo();
      const old = p.lines;
      p.lines = L.fromWorker(res.lines);
      if (old.length === p.lines.length) p.lines.forEach((l, i) => { l.singer = old[i].singer || 1; });
      p.lyricsText = texts.join('\n');
      hideBusy();
      afterLinesChanged(`Synced ${p.lines.length} lines.`);
    } catch (e) {
      hideBusy();
      const err = parseErr(e);
      if (err.cancelled) toast('Cancelled.');
      else toast(err.message + (err.log ? '\nSee App settings > Open logs folder.' : ''), true);
    }
  }
  function afterLinesChanged(msg) {
    S.selected = null; timeline.sel = null;
    renderLineList(); rebuild(); markDirty();
    $('#lyricsEdit').hidden = true;
    if (msg) toast(msg);
  }

  // ---------------------------------------------------------------- word nudging
  function flatWords() {
    const out = [];
    S.p.lines.forEach((l, li) => l.words.forEach((w, wi) => out.push({ li, wi, w })));
    return out;
  }
  function selectedIndex(flat) {
    return S.selected ? flat.findIndex((f) => f.li === S.selected.li && f.wi === S.selected.wi) : -1;
  }
  function selectFlat(flat, k) {
    if (k < 0 || k >= flat.length) return;
    S.selected = { li: flat[k].li, wi: flat[k].wi };
    timeline.sel = S.selected;
    timeline.reveal(flat[k].w.start);
    S.needsDraw = true;
  }
  function roundWord(w) { w.start = L.round3(w.start); w.end = L.round3(w.end); }
  function nudge(dt, part) {
    const flat = flatWords();
    const k = selectedIndex(flat);
    if (k < 0) return;
    pushUndo('nudge');
    const w = flat[k].w;
    const prev = k > 0 ? flat[k - 1].w : null;
    const next = k < flat.length - 1 ? flat[k + 1].w : null;
    const lo = prev ? prev.start + 0.04 : 0;
    const hi = next ? next.end - 0.04 : duration() || 1e9;
    if (part === 'start') w.start = clamp(w.start + dt, lo, w.end - 0.04);
    else if (part === 'end') w.end = clamp(w.end + dt, w.start + 0.04, hi);
    else {
      const len = w.end - w.start;
      const s = clamp(w.start + dt, lo, (next ? next.end - 0.04 : hi) - len);
      w.start = s; w.end = s + len;
    }
    if (prev && prev.end > w.start) prev.end = w.start;
    if (next && next.start < w.end) next.start = w.end;
    roundWord(w); if (prev) roundWord(prev); if (next) roundWord(next);
    timeline.reveal(w.start);
    rebuild(); markDirty();
  }
  // Hold-to-sync: hold K while a word is sung, release when it ends.
  function tapDown() {
    if (S.tap || audio.paused) return;
    const flat = flatWords();
    if (!flat.length) return;
    let k = selectedIndex(flat);
    const t = getTime();
    if (k < 0) k = Math.max(0, flat.findIndex((f) => f.w.end > t));
    pushUndo('tap');
    const w = flat[k].w;
    const prev = k > 0 ? flat[k - 1].w : null;
    w.start = L.round3(Math.max(t, prev ? prev.start + 0.04 : 0));
    if (prev && prev.end > w.start) prev.end = w.start;
    if (w.end < w.start + 0.04) w.end = w.start + 0.04;
    S.tap = { k };
    selectFlat(flat, k);
    rebuild();
  }
  function tapUp() {
    if (!S.tap) return;
    const flat = flatWords();
    const k = S.tap.k;
    S.tap = null;
    const w = flat[k] && flat[k].w;
    if (!w) return;
    w.end = L.round3(Math.max(getTime(), w.start + 0.04));
    for (let j = k + 1; j < flat.length && flat[j].w.start < flat[j - 1].w.end; j++) {
      const len = flat[j].w.end - flat[j].w.start;
      flat[j].w.start = flat[j - 1].w.end;
      flat[j].w.end = L.round3(flat[j].w.start + Math.max(0.04, len));
    }
    selectFlat(flat, k + 1);
    rebuild(); markDirty();
  }

  // ---------------------------------------------------------------- playback
  function audioPaths() {
    const p = S.p;
    const inst = (p.stems && p.stems.instrumental) || (p.mode === 'inst' ? p.source : null);
    const mix = (p.stems && p.stems.mix) || (p.mode === 'song' ? p.source : null);
    return { inst, mix };
  }
  function setAudioSource() {
    const { inst, mix } = audioPaths();
    if (S.monitor === 'mix' && !mix) S.monitor = 'inst';
    if (S.monitor === 'inst' && !inst) S.monitor = 'mix';
    const src = S.monitor === 'mix' ? mix : inst;
    const t = getTime();
    const wasPlaying = !audio.paused;
    if (src) {
      const url = sl.fileUrl(src);
      if (audio.src !== url) {
        audio.src = url;
        audio.addEventListener('loadedmetadata', () => {
          audio.currentTime = Math.min(t, audio.duration || t);
          audio.playbackRate = Number($('#btnSpeed').dataset.v || 1);
          if (wasPlaying) play();
        }, { once: true });
      }
    } else {
      audio.removeAttribute('src');
      audio.load();
    }
    $$('#monitor button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.monitor));
    $('#monitor button[data-v="inst"]').disabled = !inst;
    $('#monitor button[data-v="mix"]').disabled = !mix;
    const p = S.p;
    $('#audioInfo').textContent = p.mode === 'inst'
      ? `Instrumental: ${sl.basename(p.source)}` + (p.vocalFile ? `\nVocals for syncing: ${sl.basename(p.vocalFile)}` : '\nNo vocal track.')
      : (p.stems ? 'The AI split the song into an instrumental and vocals.' : 'Vocals not removed yet.');
    S.needsDraw = true;
  }
  function play() { if (audio.src) audio.play().catch(() => {}); }
  function pause() { audio.pause(); }
  function togglePlay() { if (audio.paused) play(); else pause(); }
  function seek(t) {
    if (!audio.src) return;
    if (audio.readyState < 1) { // not loaded yet: seek once it is
      audio.addEventListener('loadedmetadata', () => seek(t), { once: true });
      return;
    }
    audio.currentTime = clamp(t, 0, duration() || t);
    timeline.reveal(audio.currentTime);
    syncBgVideo(true);
    S.needsDraw = true;
  }
  audio.addEventListener('play', () => { $('#btnPlay').classList.add('playing'); if (S.media.video) S.media.video.play().catch(() => {}); });
  audio.addEventListener('pause', () => { $('#btnPlay').classList.remove('playing'); if (S.media.video) S.media.video.pause(); tapUp(); });
  audio.addEventListener('seeked', () => { S.needsDraw = true; });

  function syncBgVideo(force) {
    const v = S.media.video;
    if (!v || !v.duration) return;
    const want = getTime() % v.duration;
    if (force || Math.abs(v.currentTime - want) > 0.35) v.currentTime = want;
  }
  function loadBgMedia() {
    const bg = S.p.style.bg;
    S.media.image = null;
    if (S.media.video) S.media.video.pause();
    S.media.video = null;
    if (bg.type === 'image' && bg.path) {
      const img = new Image();
      img.onload = () => { S.needsDraw = true; };
      img.src = sl.fileUrl(bg.path);
      S.media.image = img;
    } else if (bg.type === 'video' && bg.path) {
      bgVideo.src = sl.fileUrl(bg.path);
      bgVideo.onloadeddata = () => { syncBgVideo(true); S.needsDraw = true; };
      bgVideo.onseeked = () => { S.needsDraw = true; };
      S.media.video = bgVideo;
    } else {
      bgVideo.removeAttribute('src');
    }
    $('#bgFileName').textContent = bg.path && bg.type !== 'color' ? sl.basename(bg.path) : '';
    S.needsDraw = true;
  }
  function bgLabel() {
    const bg = S.p.style.bg;
    if (bg.type === 'color') return 'Background: color ' + bg.color.toUpperCase();
    return (bg.type === 'image' ? 'Background image: ' : 'Background video: ') + (bg.path ? sl.basename(bg.path) : 'none chosen');
  }

  // ---------------------------------------------------------------- frame loop
  function frame() {
    if (S.p && !$('#app').hidden) {
      const playing = !audio.paused;
      const t = getTime();
      if (playing) { timeline.followTime(t); syncBgVideo(false); }
      if (playing || S.needsDraw) {
        if (S.scene) window.SLRender.drawFrame(pctx, S.scene, t, S.media, S.fontAlias);
        timeline.draw();
        $('#timeNow').textContent = L.fmtTime(t);
        $('#timeDur').textContent = L.fmtTime(duration(), false);
        highlightCurrentLine(t);
        S.needsDraw = false;
      }
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- fields
  function setSeg(sel, v) { $$(sel + ' button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }
  function onSeg(sel, fn) {
    $$(sel + ' button').forEach((b) => b.addEventListener('click', () => { if (b.disabled) return; setSeg(sel, b.dataset.v); fn(b.dataset.v); }));
  }
  function fillAll() {
    const p = S.p;
    const st = p.style;
    $('#projTitle').textContent = p.title || 'Untitled';
    setSeg('#segAspect', st.aspect);
    setSeg('#segLayout', st.layout);
    setSeg('#segPosition', st.position);
    setSeg('#segBg', st.bg.type);
    $('#inFont').value = st.font.family || '';
    $('#inSize').value = st.fontSize; $('#outSize').textContent = st.fontSize + ' px';
    $('#inBold').checked = st.bold;
    $('#inShadow').checked = st.shadow;
    $('#inCountdown').checked = st.countdown;
    $('#inTitleCard').checked = st.showTitle;
    $('#cText').value = st.textColor; $('#cWipe').value = st.wipeColor; $('#cWipe2').value = st.wipeColor2;
    $('#cWipe3').value = st.wipeColor3; $('#cOutline').value = st.outlineColor;
    $('#inOutline').value = st.outlineWidth; $('#outOutline').textContent = st.outlineWidth + ' px';
    $('#cBg').value = st.bg.color;
    $('#inDim').value = st.bg.dim; $('#outDim').textContent = Math.round(st.bg.dim * 100) + '%';
    const file = st.bg.type !== 'color';
    $('#bgFileRow').hidden = !file;
    $('#dimField').hidden = !file;
    $('#btnBgFile').textContent = st.bg.type === 'image' ? 'Choose an image' : 'Choose a video';
    $('#edTitle').value = p.title || '';
    $('#edArtist').value = p.artist || '';
    $('#btnResync').disabled = !(p.stems && p.stems.vocals);
    renderLineList();
    updateUndoButtons();
  }
  function styleChanged(key) { if (key !== false) pushUndo(key); rebuild(); markDirty(); }

  // ---------------------------------------------------------------- settings sections + rail
  function openSection(name) {
    const sec = $(`.sec[data-sec="${name}"]`);
    if (!sec) return;
    sec.open = true;
    sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
    sec.classList.add('flash');
    setTimeout(() => sec.classList.remove('flash'), 600);
    updateRail();
  }
  function updateRail() {
    $$('#rail button').forEach((b) => b.classList.toggle('on', $(`.sec[data-sec="${b.dataset.sec}"]`).open));
  }

  // ---------------------------------------------------------------- export
  function openExport() {
    pause();
    const p = S.p;
    const { mix } = audioPaths();
    const canLyric = !!mix;
    const canKaraoke = !!audioPaths().inst;
    $('#choiceType button[data-v="lyric"]').disabled = !canLyric;
    $('#choiceType button[data-v="karaoke"]').disabled = !canKaraoke;
    if (p.exportOpts.type === 'lyric' && !canLyric) p.exportOpts.type = 'karaoke';
    if (p.exportOpts.type === 'karaoke' && !canKaraoke) p.exportOpts.type = 'lyric';
    fillExport();
    $('#exportDone').hidden = true;
    $('#exportSheet').hidden = false;
  }
  function exportSize() {
    const [W, H] = Lay.dims(S.p.style.aspect);
    const k = S.p.exportOpts.height / Math.min(W, H);
    return { width: Math.round(W * k), height: Math.round(H * k) };
  }
  function fillExport() {
    const e = S.p.exportOpts;
    $$('#choiceType button').forEach((b) => b.classList.toggle('on', b.dataset.v === e.type));
    setSeg('#segRes', String(e.height));
    const { width, height } = exportSize();
    $('#exSummary').textContent = `${width} × ${height} (${S.p.style.aspect}), H.264 MP4, ${L.fmtTime(duration(), false)} long.`;
  }
  async function runExport() {
    const p = S.p;
    if (!p.lines.length) { toast('There are no lyrics to put in the video.', true); return; }
    if (!p.style.font.path) { toast('Pick a font in Text style first.', true); return; }
    const type = p.exportOpts.type;
    const { inst, mix } = audioPaths();
    const audioPath = type === 'karaoke' ? inst : mix;
    if (!audioPath) { toast('That audio is not available for this project.', true); return; }
    const suggested = (p.artist ? p.artist + ' - ' : '') + (p.title || 'SingLine') + (type === 'karaoke' ? ' (Karaoke)' : ' (Lyrics)');
    const out = await sl.saveVideoDialog(suggested);
    if (!out) return;
    await saveNow();
    rebuild();
    const ass = window.SLAss.buildAss(S.scene, { title: p.title });
    const { width, height } = exportSize();
    $('#exportSheet').hidden = true;
    showBusy('Exporting');
    try {
      await sl.exportVideo({
        ass, fontPaths: [p.style.font.path, p.style.font.boldPath], background: p.style.bg, audioPath,
        duration: duration(), outPath: out, width, height, fps: 30,
      });
      hideBusy();
      $('#exportSheet').hidden = false;
      $('#exportDone').hidden = false;
      $('#exportPath').textContent = out;
      $('#exportDone').dataset.path = out;
    } catch (e) {
      hideBusy();
      $('#exportSheet').hidden = false;
      const err = parseErr(e);
      if (err.cancelled) toast('Export cancelled.');
      else toast(err.message, true);
    }
  }

  // ---------------------------------------------------------------- busy modal (editor jobs)
  let offProgress = null;
  function showBusy(label) {
    $('#busyLabel').textContent = label;
    $('#busyMsg').textContent = 'Starting…';
    $('#busyBar').style.width = '0%';
    $('#busyPct').textContent = '0%';
    $('#busy').hidden = false;
    offProgress = sl.onProgress((p) => {
      if (p.label) $('#busyLabel').textContent = p.label;
      if (p.msg) $('#busyMsg').textContent = p.msg;
      const pct = clamp(p.pct || 0, 0, 100);
      $('#busyBar').style.width = pct + '%';
      $('#busyPct').textContent = Math.floor(pct) + '%';
    });
  }
  function hideBusy() {
    $('#busy').hidden = true;
    if (offProgress) offProgress();
    offProgress = null;
  }

  // ---------------------------------------------------------------- app settings
  async function openSettings() {
    const s = await sl.getSettings();
    $('#inDevice').value = s.device || 'auto';
    const info = await sl.appInfo();
    $('#aboutLine').textContent = `Version ${info.version}. Projects: Documents\\SingLine Projects`;
    $('#settings').hidden = false;
  }
  async function checkEngine() {
    $('#engineInfo').textContent = 'Checking…';
    const r = await sl.aiInfo();
    if (r.error) { $('#engineInfo').textContent = 'The AI engine did not start:\n' + parseErr(r.error).message; return; }
    $('#engineInfo').textContent =
      `Ready. PyTorch ${r.torch}.\n` +
      (r.cuda ? `NVIDIA GPU found: ${r.gpu}` : 'No NVIDIA GPU found, the CPU will be used.') + '\n' +
      `Speech model (${r.whisperModel}): ${r.whisperReady ? 'installed' : 'missing'}\n` +
      `Vocal separation model: ${r.demucsReady ? 'installed' : 'missing'}`;
  }

  // ---------------------------------------------------------------- timeline
  const timeline = new window.SLTimeline($('#timeline'), {
    getLines: () => (S.p ? S.p.lines : []),
    getTime,
    getDuration: () => (S.p ? duration() : 0),
    getBgLabel: () => (S.p ? bgLabel() : ''),
    onSeek: (t) => seek(t),
    onSelect: (sel) => { S.selected = sel; S.needsDraw = true; },
    onEditStart: () => { S.undo.push(snapshot()); S.redo = []; S.undoKey = null; },
    onEdit: () => { rebuild(); },
    onEditEnd: (moved) => {
      if (!moved) S.undo.pop();
      else { S.p.lines.forEach((l) => l.words.forEach(roundWord)); rebuild(); markDirty(); renderLineList(); }
      updateUndoButtons();
    },
    onZoom: (f) => {
      $('#inZoom').value = Math.round(f * 100);
      $('#zoomVal').textContent = (timeline.pps / 120).toFixed(timeline.pps < 120 ? 1 : 0) + '×';
    },
  });

  // ================================================================= wiring
  function wireDrop(el, onPath) {
    ['dragenter', 'dragover'].forEach((ev) => el.addEventListener(ev, (e) => { e.preventDefault(); el.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => el.addEventListener(ev, () => el.classList.remove('over')));
    el.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      const f = e.dataTransfer.files[0];
      if (f) onPath(sl.pathForFile(f));
    });
  }

  function wire() {
    $('#wzLang').innerHTML = LANGS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');

    // start
    $('#btnNewSong').onclick = () => startWizard('song');
    $('#btnNewInst').onclick = () => startWizard('inst');
    $('#btnOpen').onclick = async () => { const f = await sl.openDialog('project'); if (f) openProject(f); };

    // wizard
    $('#wzBack').onclick = async () => {
      if (S.page === 'source') { await saveNow(); showWelcome(); }
      else if (S.page === 'vocals') gotoPage('source');
      else if (S.page === 'work') gotoPage(S.p.mode === 'inst' ? 'vocals' : 'source');
    };
    const pickSource = async () => chooseSource(await sl.openDialog('song'));
    const pickVocals = async () => chooseVocals(await sl.openDialog('song'));
    $('#dropSource').onclick = pickSource;
    $('#dropVocals').onclick = pickVocals;
    $('#dropSource').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickSource(); } };
    $('#dropVocals').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickVocals(); } };
    $('#srcReplace').onclick = pickSource;
    $('#vocReplace').onclick = pickVocals;
    wireDrop($('#dropSource'), chooseSource);
    wireDrop($('#dropVocals'), chooseVocals);
    $('#wzTitle').oninput = updateWizardButtons;
    $('#wzLyrics').oninput = updateWizardButtons;
    $('#wzLoadLyrics').onclick = async () => {
      const p = await sl.openDialog('lyrics');
      if (!p) return;
      let text = await sl.readText(p);
      if (/\.lrc$/i.test(p)) {
        text = text.split(/\r?\n/).map((line) => {
          const m = line.match(/^\[(ti|ar|al|by|offset|length|re|ve):(.*)\]\s*$/i);
          if (m) {
            if (m[1].toLowerCase() === 'ti' && !$('#wzTitle').value.trim()) $('#wzTitle').value = m[2].trim();
            if (m[1].toLowerCase() === 'ar' && !$('#wzArtist').value.trim()) $('#wzArtist').value = m[2].trim();
            return null;
          }
          return line.replace(/\[[^\]]*\]/g, '').replace(/<[^>]*>/g, '').trim();
        }).filter((l) => l !== null).join('\n');
      }
      $('#wzLyrics').value = text.trim();
      updateWizardButtons();
    };
    $('#wzSaveContinue').onclick = saveAndContinue;
    $('#wzSync').onclick = () => runJob('inst');
    $('#wzManual').onclick = continueManually;
    $('#workCancel').onclick = () => { $('#workMsg').textContent = 'Stopping…'; sl.cancelJob(); };
    $('#workRetry').onclick = () => runJob(S.lastJob);
    $('#workManual').onclick = continueManually;

    // editor top bar
    $('#btnHome').onclick = showWelcome;
    $('#btnUndo').onclick = () => undo(false);
    $('#btnRedo').onclick = () => undo(true);
    $('#btnExportOpen').onclick = openExport;
    $('#btnSettings').onclick = openSettings;

    // rail + sections
    $$('#rail button').forEach((b) => (b.onclick = () => openSection(b.dataset.sec)));
    $$('.sec').forEach((d) => d.addEventListener('toggle', updateRail));

    // lyrics section
    $('#btnEditLyrics').onclick = () => {
      $('#edLyrics').value = S.p.lines.map(L.lineText).join('\n');
      $('#lyricsEdit').hidden = false;
      $('#edLyrics').focus();
    };
    $('#btnLyricsCancel').onclick = () => { $('#lyricsEdit').hidden = true; };
    $('#btnLyricsSave').onclick = () => {
      const texts = $('#edLyrics').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!texts.length) { toast('The lyrics are empty.', true); return; }
      resync(texts);
    };
    $('#btnResync').onclick = () => {
      if (!confirm('Sync all lyrics again with the AI? Your manual timing changes will be replaced (you can undo).')) return;
      resync(S.p.lines.map(L.lineText));
    };

    // look
    onSeg('#segAspect', (v) => { S.p.style.aspect = v; styleChanged(); });
    onSeg('#segLayout', (v) => { S.p.style.layout = v; styleChanged(); });
    onSeg('#segPosition', (v) => { S.p.style.position = v; styleChanged(); });
    onSeg('#segBg', (v) => {
      pushUndo();
      const bg = S.p.style.bg;
      if (v !== bg.type) bg.path = (v === 'video' && S.p.sourceHasVideo) ? S.p.source : '';
      bg.type = v;
      fillAll(); loadBgMedia(); styleChanged(false);
    });
    $('#inFont').addEventListener('change', async (e) => {
      const f = S.fonts.find((x) => x.family.toLowerCase() === e.target.value.trim().toLowerCase());
      if (!f) { toast('That font is not installed. Pick one from the list.', true); e.target.value = S.p.style.font.family; return; }
      pushUndo();
      S.p.style.font = fontRef(f);
      await applyFont(S.p.style.font);
      markDirty();
    });
    $('#inSize').oninput = (e) => { S.p.style.fontSize = Number(e.target.value); $('#outSize').textContent = e.target.value + ' px'; styleChanged('size'); };
    $('#inOutline').oninput = (e) => { S.p.style.outlineWidth = Number(e.target.value); $('#outOutline').textContent = e.target.value + ' px'; styleChanged('outline'); };
    $('#inDim').oninput = (e) => { S.p.style.bg.dim = Number(e.target.value); $('#outDim').textContent = Math.round(e.target.value * 100) + '%'; styleChanged('dim'); };
    [['#inBold', 'bold'], ['#inShadow', 'shadow'], ['#inCountdown', 'countdown'], ['#inTitleCard', 'showTitle']].forEach(([sel, key]) => {
      $(sel).onchange = (e) => { pushUndo(); S.p.style[key] = e.target.checked; styleChanged(false); };
    });
    [['#cText', 'textColor'], ['#cWipe', 'wipeColor'], ['#cWipe2', 'wipeColor2'], ['#cWipe3', 'wipeColor3'], ['#cOutline', 'outlineColor']].forEach(([sel, key]) => {
      $(sel).oninput = (e) => { S.p.style[key] = e.target.value; styleChanged('c-' + key); };
    });
    $('#cBg').oninput = (e) => { S.p.style.bg.color = e.target.value; styleChanged('c-bg'); };
    $('#btnBgFile').onclick = async () => {
      const kind = S.p.style.bg.type === 'image' ? 'image' : 'video';
      const p = await sl.openDialog(kind);
      if (!p) return;
      pushUndo();
      S.p.style.bg.path = p;
      loadBgMedia(); styleChanged(false);
    };
    $('#edTitle').oninput = (e) => { S.p.title = e.target.value; $('#projTitle').textContent = S.p.title || 'Untitled'; styleChanged('title'); };
    $('#edArtist').oninput = (e) => { S.p.artist = e.target.value; styleChanged('artist'); };

    // audio
    $$('#monitor button').forEach((b) => (b.onclick = () => { if (b.disabled) return; S.monitor = b.dataset.v; setAudioSource(); }));
    $('#btnStems').onclick = () => {
      const p = S.p;
      const any = (p.stems && (p.stems.instrumental || p.stems.vocals)) || p.source;
      if (any) sl.showInFolder(any);
    };

    // transport
    $('#btnPlay').onclick = togglePlay;
    $('#btnToStart').onclick = () => seek(0);
    $('#btnSpeed').dataset.v = '1';
    $('#btnSpeed').onclick = () => {
      const cur = Number($('#btnSpeed').dataset.v);
      const next = SPEEDS[(SPEEDS.indexOf(cur) + 1) % SPEEDS.length];
      $('#btnSpeed').dataset.v = String(next);
      $('#btnSpeed').textContent = next + '×';
      audio.playbackRate = next;
    };
    $('#inVol').oninput = (e) => { audio.volume = Number(e.target.value); };
    audio.volume = 0.9;
    $('#btnZoomIn').onclick = () => timeline.zoom(1.4);
    $('#btnZoomOut').onclick = () => timeline.zoom(1 / 1.4);
    $('#inZoom').oninput = (e) => timeline.setZoomFrac(Number(e.target.value) / 100);
    $('#inTap').onchange = () => {
      toast($('#inTap').checked ? 'Hold-to-sync is on: play, then hold K while each word is sung. It starts from the selected word.' : 'Hold-to-sync is off.');
      $('#inTap').blur();
    };

    // export
    $$('#choiceType button').forEach((b) => (b.onclick = () => {
      if (b.disabled) return;
      S.p.exportOpts.type = b.dataset.v;
      fillExport(); markDirty();
    }));
    onSeg('#segRes', (v) => { S.p.exportOpts.height = Number(v); fillExport(); markDirty(); });
    $('#btnExport').onclick = runExport;
    $('#btnExportClose').onclick = () => { $('#exportSheet').hidden = true; };
    $('#btnPlayExport').onclick = () => sl.openPath($('#exportDone').dataset.path);
    $('#btnShowExport').onclick = () => sl.showInFolder($('#exportDone').dataset.path);
    $('#btnCancel').onclick = () => { $('#busyMsg').textContent = 'Stopping…'; sl.cancelJob(); };

    // app settings
    $('#btnCloseSettings').onclick = () => { $('#settings').hidden = true; };
    $('#btnCheckEngine').onclick = checkEngine;
    $('#btnOpenLogs').onclick = () => sl.openLogs();
    $('#inDevice').onchange = (e) => sl.setSettings({ device: e.target.value });

    // window
    new ResizeObserver(fitPreview).observe($('#stage'));
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (!f) return;
      const p = sl.pathForFile(f);
      if (/\.singline$/i.test(p)) openProject(p);
    });
    window.addEventListener('keydown', (e) => {
      const modalOpen = !$('#busy').hidden || !$('#settings').hidden || !$('#exportSheet').hidden;
      if (e.key === 'Escape') {
        if (!$('#settings').hidden) $('#settings').hidden = true;
        else if (!$('#exportSheet').hidden) $('#exportSheet').hidden = true;
        return;
      }
      if ($('#app').hidden || modalOpen) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); return; }
      if (isTyping(document.activeElement)) return;
      const k = e.key;
      if (k === ' ') { e.preventDefault(); togglePlay(); return; }
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey); return; }
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); undo(true); return; }
      if (k.toLowerCase() === 'k' && $('#inTap').checked) { e.preventDefault(); if (!e.repeat) tapDown(); return; }
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        if (!S.selected) return;
        e.preventDefault();
        const dt = (e.shiftKey ? 0.1 : 0.01) * (k === 'ArrowLeft' ? -1 : 1);
        nudge(dt, e.altKey ? 'end' : e.ctrlKey ? 'start' : 'both');
        return;
      }
      if (k === 'Tab' && S.p.lines.length) {
        e.preventDefault();
        const flat = flatWords();
        const i = selectedIndex(flat);
        selectFlat(flat, i < 0 ? 0 : i + (e.shiftKey ? -1 : 1));
      }
    });
    window.addEventListener('keyup', (e) => { if (e.key.toLowerCase() === 'k') tapUp(); });
    window.addEventListener('beforeunload', () => { if (S.saveTimer) saveNow(); });
    sl.onOpenFile((p) => openProject(p));
  }

  // ================================================================= boot
  async function boot() {
    wire();
    requestAnimationFrame(frame);
    initFonts();
    timeline.setZoomFrac(0.4);
    const info = await sl.appInfo();
    $('#welcomeFoot').textContent = `Version ${info.version}. Works offline.`;
    const pending = await sl.pendingOpen();
    if (pending) openProject(pending);
    else showWelcome();
  }
  boot();
})();
