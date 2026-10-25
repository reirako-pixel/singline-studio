// SingLine Studio - UI logic.
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
  const SONG_EXT = /\.(mp3|wav|flac|aac|m4a|ogg|opus|wma|mp4|mkv|mov|webm|avi)$/i;

  const S = {
    dir: null, p: null, step: 'song', scene: null,
    fonts: [], fontAlias: 'Segoe UI', loadedFonts: new Map(),
    selected: null, undo: [], redo: [], lastNudge: 0,
    monitor: 'inst', saveTimer: null, needsDraw: true, tap: null,
    media: { image: null, video: null }, currentLine: -1,
  };

  const audio = $('#audio');
  const bgVideo = $('#bgVideo');
  const preview = $('#preview');
  const pctx = preview.getContext('2d');
  const measure = window.SLRender.makeMeasure(() => S.fontAlias);

  function newProject() {
    return {
      version: 1, title: '', artist: '', source: '', sourceHasVideo: false,
      stems: null, duration: 0, language: 'auto', lyricsText: '', lines: [],
      style: Lay.withDefaults({}), exportOpts: { type: 'karaoke', height: 1080 }, created: Date.now(),
    };
  }

  // ------------------------------------------------------------------ toast
  let toastTimer;
  function toast(msg, isError = false, ms = 4200) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), isError ? Math.max(ms, 7000) : ms);
  }

  // ------------------------------------------------------------------ saving
  function markDirty() {
    if (!S.dir) return;
    $('#saveState').textContent = 'Saving…';
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(saveNow, 700);
  }
  async function saveNow() {
    if (!S.dir || !S.p) return;
    clearTimeout(S.saveTimer);
    try {
      await sl.saveProject(S.dir, S.p);
      $('#saveState').textContent = 'Saved';
    } catch (e) {
      $('#saveState').textContent = 'Not saved';
      toast('Could not save the project: ' + e.message, true);
    }
  }

  // ------------------------------------------------------------------ scene
  function rebuild() {
    if (!S.p) return;
    S.scene = Lay.buildScene(S.p, measure);
    S.needsDraw = true;
  }
  const getTime = () => (audio.src ? audio.currentTime || 0 : 0);
  const duration = () => S.p.duration || audio.duration || 0;

  // ------------------------------------------------------------------ fonts
  async function initFonts() {
    try {
      S.fonts = await sl.fonts();
    } catch {
      S.fonts = [];
    }
    $('#fontList').innerHTML = S.fonts.map((f) => `<option value="${escapeAttr(f.family)}">`).join('');
    $('#inFont').placeholder = S.fonts.length ? 'Type to search ' + S.fonts.length + ' fonts' : 'No fonts found';
    if (S.p) await resolveFont();
  }

  // Make sure the project's font has a file path (needed for export) and is loaded.
  async function resolveFont() {
    const st = S.p.style;
    // Always look the family up again: font files can live elsewhere on
    // another PC, and older projects did not store the Bold file.
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

  const fontRef = (f) => ({ family: f.family, path: f.path, boldPath: f.boldPath || null, metrics: f.metrics });

  async function applyFont(font) {
    if (!font || !font.path) { S.fontAlias = (font && font.family) || 'Segoe UI'; rebuild(); return; }
    let alias = S.loadedFonts.get(font.path);
    if (!alias) {
      alias = 'slf' + S.loadedFonts.size;
      try {
        // Register the exact files the export will use: Regular at 400 and,
        // when the family has one, the real Bold at 700.
        const faces = [new FontFace(alias, `url("${sl.fileUrl(font.path)}")`, { weight: '400' })];
        if (font.boldPath) faces.push(new FontFace(alias, `url("${sl.fileUrl(font.boldPath)}")`, { weight: '700' }));
        for (const face of faces) { await face.load(); document.fonts.add(face); }
      } catch {
        alias = font.family; // fall back to the system-installed family name
      }
      S.loadedFonts.set(font.path, alias);
    }
    S.fontAlias = alias;
    rebuild();
  }

  // ------------------------------------------------------------------ steps
  function goto(step) {
    S.step = step;
    $$('#steps button').forEach((b) => b.classList.toggle('active', b.dataset.step === step));
    $$('#panel section').forEach((s) => s.classList.toggle('active', s.dataset.panel === step));
    if (step === 'sync') renderLineList();
    if (step === 'lyrics') updateProcessButton();
    markDone();
  }
  function markDone() {
    const p = S.p;
    const done = { song: !!p.source, lyrics: p.lines.length > 0, sync: p.lines.length > 0, style: false, export: false };
    $$('#steps button').forEach((b) => b.classList.toggle('done', !!done[b.dataset.step] && b.dataset.step !== S.step));
  }

  // ------------------------------------------------------------------ project lifecycle
  function showApp() {
    $('#welcome').hidden = true;
    $('#app').hidden = false;
    timeline.resize();
  }

  async function showWelcome() {
    await saveNow();
    pause();
    $('#app').hidden = true;
    $('#welcome').hidden = false;
    const recent = await sl.recentProjects();
    $('#recentWrap').hidden = !recent.length;
    $('#recentList').innerHTML = '';
    for (const r of recent) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.innerHTML = `<span></span><span class="when"></span>`;
      b.firstChild.textContent = r.title || sl.basename(r.file.replace(/[\\/]project\.singline$/, ''));
      b.lastChild.textContent = new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      b.onclick = () => openProject(r.file);
      li.appendChild(b);
      $('#recentList').appendChild(li);
    }
  }

  function startNew() {
    S.dir = null;
    S.p = newProject();
    S.undo = []; S.redo = []; S.selected = null;
    setAudioSource();
    loadBgMedia();
    timeline.setPeaks(null);
    fillAllFields();
    resolveFont();
    showApp();
    goto('song');
    $('#saveState').textContent = '';
  }

  async function openProject(file) {
    try {
      const { dir, project } = await sl.loadProject(file);
      S.dir = dir;
      S.p = { ...newProject(), ...project };
      S.p.style = Lay.withDefaults(project.style);
      S.p.exportOpts = { type: 'karaoke', height: 1080, ...(project.exportOpts || {}) };
      S.undo = []; S.redo = []; S.selected = null;
      fillAllFields();
      setAudioSource();
      loadBgMedia();
      timeline.setPeaks(null);
      if (S.p.stems && S.p.stems.vocals) sl.peaks(S.p.stems.vocals).then((p) => timeline.setPeaks(p)).catch(() => {});
      await resolveFont();
      showApp();
      goto(S.p.lines.length ? 'sync' : S.p.source ? 'lyrics' : 'song');
      $('#saveState').textContent = 'Saved';
    } catch (e) {
      toast('Could not open that project: ' + e.message, true);
    }
  }

  // ------------------------------------------------------------------ song
  function guessTitle(path) {
    const name = sl.basename(path).replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
    const m = name.match(/^(.+?)\s+-\s+(.+)$/);
    return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: name };
  }

  async function chooseSong(path) {
    if (!path) return;
    if (!SONG_EXT.test(path)) { toast('That file type is not supported. Use an audio file or a music video.', true); return; }
    if (S.p.stems && !confirm('Start a new project with this song? The current project stays saved.')) return;
    if (S.p.stems) startNew();
    const info = await sl.probe(path);
    if (!info.hasAudio) { toast('That file has no audio track.', true); return; }
    const g = guessTitle(path);
    if (!S.p.title) S.p.title = g.title;
    if (!S.p.artist) S.p.artist = g.artist;
    S.p.source = path;
    S.p.sourceHasVideo = info.hasVideo;
    S.p.duration = info.duration;
    if (info.hasVideo && S.p.style.bg.type === 'color') {
      S.p.style.bg = { ...S.p.style.bg, type: 'video', path, dim: 0.45 };
      loadBgMedia();
    }
    if (!S.dir) S.dir = await sl.newProjectDir(S.p.title || 'Untitled');
    fillAllFields();
    setAudioSource();
    rebuild();
    markDirty();
    markDone();
    toast(info.hasVideo ? 'Music video added. Its video is set as the background.' : 'Song added. Next, paste the lyrics.');
  }

  function updateSongCard() {
    const has = !!S.p.source;
    $('#dropSong').classList.toggle('has-file', has);
    $('#songName').textContent = has ? sl.basename(S.p.source) : 'Drop a song or music video here';
    $('#songMeta').textContent = has
      ? `${L.fmtTime(S.p.duration, false)} · ${S.p.sourceHasVideo ? 'music video' : 'audio'}${S.p.stems ? ' · vocals removed' : ''}`
      : 'MP3, WAV, FLAC, AAC, M4A, OGG, or an MP4/MKV/MOV music video';
    $('#btnChooseSong').textContent = has ? 'Choose a different file' : 'Choose a file';
    $('#stageEmpty').hidden = has;
  }

  // ------------------------------------------------------------------ lyrics + AI
  function lyricLines() {
    return $('#inLyrics').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  function updateProcessButton() {
    const n = lyricLines().length;
    $('#lyricsCount').textContent = n ? n + (n === 1 ? ' line' : ' lines') : '';
    const b = $('#btnProcess');
    b.disabled = !S.p.source;
    if (S.p.stems) b.textContent = n ? 'Sync lyrics again' : 'Write out lyrics with AI';
    else b.textContent = n ? 'Remove vocals and sync' : 'Remove vocals and write out lyrics';
    $('#processHint').textContent = S.p.stems
      ? 'Vocals are already removed, so this only redoes the word sync. Manual timing edits will be replaced.'
      : 'Runs on this PC. A 4-minute song takes about 2–6 minutes on a typical CPU, faster with an NVIDIA GPU.';
  }

  async function loadLyricsFile() {
    const p = await sl.openDialog('lyrics');
    if (!p) return;
    let text = await sl.readText(p);
    if (/\.lrc$/i.test(p)) {
      const meta = {};
      text = text.split(/\r?\n/).map((line) => {
        const m = line.match(/^\[(ti|ar|al|by|offset|length|re|ve):(.*)\]\s*$/i);
        if (m) { meta[m[1].toLowerCase()] = m[2].trim(); return null; }
        return line.replace(/\[[^\]]*\]/g, '').replace(/<[^>]*>/g, '').trim();
      }).filter((l) => l !== null).join('\n');
      if (meta.ti && !S.p.title) S.p.title = meta.ti;
      if (meta.ar && !S.p.artist) S.p.artist = meta.ar;
      fillSongFields();
    }
    $('#inLyrics').value = text.trim();
    S.p.lyricsText = $('#inLyrics').value;
    updateProcessButton();
    markDirty();
  }

  function applySyncResult(res, keepSingers) {
    const old = S.p.lines;
    const lines = L.fromWorker(res.lines);
    if (keepSingers && old.length === lines.length) lines.forEach((l, i) => { l.singer = old[i].singer || 1; });
    pushUndo();
    S.p.lines = lines;
    if (res.language && S.p.language === 'auto') S.p.detectedLanguage = res.language;
    if (!lyricLines().length) {
      $('#inLyrics').value = lines.map(L.lineText).join('\n');
      S.p.lyricsText = $('#inLyrics').value;
    }
    S.selected = lines.length ? { li: 0, wi: 0 } : null;
    timeline.sel = S.selected;
    rebuild();
    markDirty();
  }

  async function runProcess() {
    if (!S.p.source) { toast('Choose a song first.', true); return; }
    await saveNow();
    pause();
    const lyrics = lyricLines();
    S.p.lyricsText = $('#inLyrics').value;
    showBusy(S.p.stems ? 'Syncing lyrics' : 'Removing vocals');
    try {
      if (!S.p.stems) {
        const res = await sl.process({ projectDir: S.dir, input: S.p.source, lyrics, lang: S.p.language });
        S.p.stems = res.stems;
        S.p.duration = res.duration || S.p.duration;
        setAudioSource();
        sl.peaks(res.stems.vocals).then((p) => timeline.setPeaks(p)).catch(() => {});
        applySyncResult(res, false);
      } else if (lyrics.length) {
        applySyncResult(await sl.align({ projectDir: S.dir, vocals: S.p.stems.vocals, lyrics, lang: S.p.language }), true);
      } else {
        applySyncResult(await sl.transcribe({ vocals: S.p.stems.vocals, lang: S.p.language }), false);
      }
      hideBusy();
      updateSongCard();
      goto('sync');
      seek(Math.max(0, (S.p.lines[0] ? L.lineStart(S.p.lines[0]) : 0) - 2));
      toast(`Synced ${S.p.lines.length} lines. Play it back and drag any word that is off.`);
    } catch (e) {
      hideBusy();
      if (e && /Cancelled/.test(e.message)) toast('Cancelled.');
      else toast(cleanErr(e), true);
    }
  }

  function cleanErr(e) {
    return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  // ------------------------------------------------------------------ busy modal
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
      const pct = Math.max(0, Math.min(100, p.pct || 0));
      $('#busyBar').style.width = pct + '%';
      $('#busyPct').textContent = Math.floor(pct) + '%';
    });
  }
  function hideBusy() {
    $('#busy').hidden = true;
    if (offProgress) offProgress();
    offProgress = null;
  }

  // ------------------------------------------------------------------ line list (sync step)
  function renderLineList() {
    const ol = $('#lineList');
    ol.innerHTML = '';
    if (!S.p.lines.length) {
      const li = document.createElement('li');
      li.style.cursor = 'default';
      li.innerHTML = '<span></span><span class="txt">No synced lyrics yet. Go to Lyrics and run the sync.</span>';
      ol.appendChild(li);
      return;
    }
    S.p.lines.forEach((line, i) => {
      const li = document.createElement('li');
      li.dataset.i = i;
      li.innerHTML = `<span class="t"></span><span class="txt"></span><span class="singer" title="Who sings this line">
        <button data-v="1">1</button><button data-v="2">2</button><button data-v="3" title="Both">B</button></span>`;
      li.querySelector('.t').textContent = L.fmtTime(L.lineStart(line));
      li.querySelector('.txt').textContent = L.lineText(line);
      li.querySelectorAll('.singer button').forEach((b) => {
        b.classList.toggle('on', Number(b.dataset.v) === (line.singer || 1));
        b.onclick = (e) => {
          e.stopPropagation();
          pushUndo();
          line.singer = Number(b.dataset.v);
          renderLineList();
          rebuild();
          markDirty();
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
      $('#inLyrics').value = S.p.lyricsText;
      S.selected = null;
      timeline.sel = null;
      renderLineList();
      rebuild();
      markDirty();
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
    if (cur === S.currentLine || S.step !== 'sync') return;
    S.currentLine = cur;
    $$('#lineList li').forEach((li) => li.classList.toggle('current', Number(li.dataset.i) === cur));
    const el = $(`#lineList li[data-i="${cur}"]`);
    if (el && !audio.paused) el.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------------ undo
  function pushUndo() {
    S.undo.push(JSON.stringify(S.p.lines));
    if (S.undo.length > 200) S.undo.shift();
    S.redo = [];
  }
  function undo(redo = false) {
    const from = redo ? S.redo : S.undo;
    const to = redo ? S.undo : S.redo;
    if (!from.length) return;
    to.push(JSON.stringify(S.p.lines));
    S.p.lines = JSON.parse(from.pop());
    S.selected = null; timeline.sel = null;
    renderLineList(); rebuild(); markDirty();
  }

  // ------------------------------------------------------------------ word editing helpers
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

  function nudge(dt, part) {
    const flat = flatWords();
    const k = selectedIndex(flat);
    if (k < 0) return;
    const now = performance.now();
    if (now - S.lastNudge > 800) pushUndo();
    S.lastNudge = now;
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
    rebuild();
    markDirty();
  }
  function roundWord(w) { w.start = L.round3(w.start); w.end = L.round3(w.end); }

  // Hold-to-sync: hold K while a word is sung, release when it ends.
  function tapDown() {
    if (S.tap || audio.paused) return;
    const flat = flatWords();
    if (!flat.length) return;
    let k = selectedIndex(flat);
    const t = getTime();
    if (k < 0) k = Math.max(0, flat.findIndex((f) => f.w.end > t));
    pushUndo();
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
    rebuild();
    markDirty();
  }

  // ------------------------------------------------------------------ playback
  function setAudioSource() {
    const p = S.p;
    let src = '';
    if (p.stems) src = S.monitor === 'mix' ? (p.stems.mix || p.source) : p.stems.instrumental;
    else if (p.source) src = p.source;
    const t = getTime();
    const wasPlaying = !audio.paused;
    if (src) {
      const url = sl.fileUrl(src);
      if (audio.src !== url) {
        audio.src = url;
        audio.addEventListener('loadedmetadata', () => { audio.currentTime = Math.min(t, audio.duration || t); if (wasPlaying) play(); }, { once: true });
      }
    } else {
      audio.removeAttribute('src');
      audio.load();
    }
    $$('#monitor button').forEach((b) => b.classList.toggle('on', b.dataset.v === (p.stems ? S.monitor : 'mix')));
    $('#monitor button[data-v="inst"]').disabled = !p.stems;
    S.needsDraw = true;
  }

  function play() {
    if (!audio.src) return;
    audio.play().catch(() => {});
  }
  function pause() { audio.pause(); }
  function togglePlay() { if (audio.paused) play(); else pause(); }
  function seek(t) {
    if (!audio.src) return;
    audio.currentTime = clamp(t, 0, duration() || t);
    timeline.reveal(audio.currentTime); // scroll the timeline only if the playhead left the view
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
    if (S.media.video) { S.media.video.pause(); }
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

  // ------------------------------------------------------------------ frame loop
  function frame() {
    const playing = !audio.paused;
    if (S.p && !$('#app').hidden) {
      const t = getTime();
      if (playing) { timeline.followTime(t); syncBgVideo(false); }
      if (playing || S.needsDraw) {
        if (S.scene) window.SLRender.drawFrame(pctx, S.scene, t, S.media, S.fontAlias);
        timeline.draw();
        $('#timeNow').textContent = L.fmtTime(t);
        const d = duration();
        $('#timeDur').textContent = L.fmtTime(d, false);
        if (document.activeElement !== $('#scrub')) $('#scrub').value = d ? Math.round((t / d) * 1000) : 0;
        highlightCurrentLine(t);
        S.needsDraw = false;
      }
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ fields
  function fillSongFields() {
    $('#inTitle').value = S.p.title || '';
    $('#inArtist').value = S.p.artist || '';
    $('#inLang').value = S.p.language || 'auto';
    updateSongCard();
  }

  function fillStyleFields() {
    const st = S.p.style;
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
  }

  function fillExportFields() {
    const e = S.p.exportOpts;
    $$('#choiceType button').forEach((b) => b.classList.toggle('on', b.dataset.v === e.type));
    setSeg('#segRes', String(e.height));
    $('#exportDone').hidden = true;
  }

  function fillAllFields() {
    fillSongFields();
    $('#inLyrics').value = S.p.lyricsText || '';
    updateProcessButton();
    fillStyleFields();
    fillExportFields();
  }

  function setSeg(sel, v) { $$(sel + ' button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }
  function onSeg(sel, fn) {
    $$(sel + ' button').forEach((b) => b.addEventListener('click', () => { setSeg(sel, b.dataset.v); fn(b.dataset.v); }));
  }
  function styleChanged() { rebuild(); markDirty(); }

  // ------------------------------------------------------------------ export
  async function runExport() {
    const p = S.p;
    if (!p.lines.length) { toast('Sync the lyrics before exporting.', true); return; }
    const type = p.exportOpts.type;
    if (type === 'karaoke' && !(p.stems && p.stems.instrumental)) { toast('Remove the vocals first (Lyrics step).', true); return; }
    if (!p.style.font.path) { toast('Pick a font in Style first.', true); return; }
    const suggested = (p.artist ? p.artist + ' - ' : '') + (p.title || 'SingLine') + (type === 'karaoke' ? ' (Karaoke)' : ' (Lyrics)');
    const out = await sl.saveVideoDialog(suggested);
    if (!out) return;
    pause();
    await saveNow();
    rebuild();
    const ass = window.SLAss.buildAss(S.scene, { title: p.title });
    const audioPath = type === 'karaoke' ? p.stems.instrumental : ((p.stems && p.stems.mix) || p.source);
    showBusy('Exporting');
    try {
      await sl.exportVideo({
        ass, fontPaths: [p.style.font.path, p.style.font.boldPath], background: p.style.bg, audioPath,
        duration: duration(), outPath: out, height: p.exportOpts.height, fps: 30,
      });
      hideBusy();
      $('#exportDone').hidden = false;
      $('#exportPath').textContent = out;
      $('#exportDone').dataset.path = out;
      toast('Exported ' + sl.basename(out));
    } catch (e) {
      hideBusy();
      if (/Cancelled/.test(cleanErr(e))) toast('Export cancelled.');
      else toast(cleanErr(e), true);
    }
  }

  // ------------------------------------------------------------------ settings
  async function openSettings() {
    const s = await sl.getSettings();
    $('#inDevice').value = s.device || 'auto';
    const info = await sl.appInfo();
    $('#aboutLine').textContent = `SingLine Studio ${info.version}. Projects are saved in Documents\\SingLine Projects.`;
    $('#settings').hidden = false;
  }
  async function checkEngine() {
    $('#engineInfo').textContent = 'Checking…';
    const r = await sl.aiInfo();
    if (r.error) { $('#engineInfo').textContent = 'The AI engine did not start:\n' + r.error; return; }
    $('#engineInfo').textContent =
      `Ready. PyTorch ${r.torch}.\n` +
      (r.cuda ? `NVIDIA GPU found: ${r.gpu}` : 'No NVIDIA GPU found, the CPU will be used.') + '\n' +
      `Speech model (${r.whisperModel}): ${r.whisperReady ? 'installed' : 'missing'}\n` +
      `Vocal separation model: ${r.demucsReady ? 'installed' : 'missing'}`;
  }

  // ------------------------------------------------------------------ helpers
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) &&
    !(el.tagName === 'INPUT' && /^(range|checkbox|color|button)$/.test(el.type));

  // ------------------------------------------------------------------ timeline
  const timeline = new window.SLTimeline($('#timeline'), {
    getLines: () => (S.p ? S.p.lines : []),
    getTime,
    getDuration: () => (S.p ? duration() : 0),
    onSeek: (t) => seek(t),
    onSelect: (sel) => { S.selected = sel; S.needsDraw = true; },
    onEditStart: () => pushUndo(),
    onEdit: () => { rebuild(); },
    onEditEnd: (moved) => {
      if (!moved) S.undo.pop();
      else { S.p.lines.forEach((l) => l.words.forEach(roundWord)); rebuild(); markDirty(); if (S.step === 'sync') renderLineList(); }
    },
  });

  // ------------------------------------------------------------------ wire up
  function wire() {
    $('#inLang').innerHTML = LANGS.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');

    $('#btnNew').onclick = startNew;
    $('#btnOpen').onclick = async () => { const f = await sl.openDialog('project'); if (f) openProject(f); };
    $('#btnHome').onclick = showWelcome;
    $$('#steps button').forEach((b) => (b.onclick = () => goto(b.dataset.step)));
    $$('[data-goto]').forEach((b) => (b.onclick = () => goto(b.dataset.goto)));

    // song
    $('#btnChooseSong').onclick = async () => chooseSong(await sl.openDialog('song'));
    $('#inTitle').oninput = (e) => { S.p.title = e.target.value; rebuild(); markDirty(); };
    $('#inArtist').oninput = (e) => { S.p.artist = e.target.value; rebuild(); markDirty(); };
    $('#inLang').onchange = (e) => { S.p.language = e.target.value; markDirty(); };
    const drop = $('#dropSong');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (!f || $('#app').hidden) return;
      const p = sl.pathForFile(f);
      if (/\.singline$/i.test(p)) openProject(p);
      else if (SONG_EXT.test(p)) chooseSong(p);
    });

    // lyrics
    $('#inLyrics').oninput = () => { S.p.lyricsText = $('#inLyrics').value; updateProcessButton(); markDirty(); };
    $('#btnLoadLyrics').onclick = loadLyricsFile;
    $('#btnProcess').onclick = runProcess;
    $('#btnCancel').onclick = () => { $('#busyMsg').textContent = 'Stopping…'; sl.cancelJob(); };

    // style
    onSeg('#segLayout', (v) => { S.p.style.layout = v; styleChanged(); });
    onSeg('#segPosition', (v) => { S.p.style.position = v; styleChanged(); });
    onSeg('#segBg', (v) => {
      const bg = S.p.style.bg;
      if (v !== bg.type) bg.path = (v === 'video' && S.p.sourceHasVideo) ? S.p.source : '';
      bg.type = v;
      fillStyleFields(); loadBgMedia(); styleChanged();
    });
    $('#inFont').addEventListener('change', async (e) => {
      const f = S.fonts.find((x) => x.family.toLowerCase() === e.target.value.trim().toLowerCase());
      if (!f) { toast('That font is not installed. Pick one from the list.', true); e.target.value = S.p.style.font.family; return; }
      S.p.style.font = fontRef(f);
      await applyFont(S.p.style.font);
      markDirty();
    });
    $('#inSize').oninput = (e) => { S.p.style.fontSize = Number(e.target.value); $('#outSize').textContent = e.target.value + ' px'; styleChanged(); };
    $('#inOutline').oninput = (e) => { S.p.style.outlineWidth = Number(e.target.value); $('#outOutline').textContent = e.target.value + ' px'; styleChanged(); };
    $('#inDim').oninput = (e) => { S.p.style.bg.dim = Number(e.target.value); $('#outDim').textContent = Math.round(e.target.value * 100) + '%'; styleChanged(); };
    [['#inBold', 'bold'], ['#inShadow', 'shadow'], ['#inCountdown', 'countdown'], ['#inTitleCard', 'showTitle']].forEach(([sel, key]) => {
      $(sel).onchange = (e) => { S.p.style[key] = e.target.checked; styleChanged(); };
    });
    [['#cText', 'textColor'], ['#cWipe', 'wipeColor'], ['#cWipe2', 'wipeColor2'], ['#cWipe3', 'wipeColor3'], ['#cOutline', 'outlineColor']].forEach(([sel, key]) => {
      $(sel).oninput = (e) => { S.p.style[key] = e.target.value; styleChanged(); };
    });
    $('#cBg').oninput = (e) => { S.p.style.bg.color = e.target.value; styleChanged(); };
    $('#btnBgFile').onclick = async () => {
      const kind = S.p.style.bg.type === 'image' ? 'image' : 'video';
      const p = await sl.openDialog(kind);
      if (!p) return;
      S.p.style.bg.path = p;
      loadBgMedia(); styleChanged();
    };

    // export
    $$('#choiceType button').forEach((b) => (b.onclick = () => {
      S.p.exportOpts.type = b.dataset.v;
      fillExportFields(); markDirty();
      if (b.dataset.v === 'lyric' && S.p.style.layout === 'karaoke') toast('Tip: the Single line layout suits lyric videos.');
    }));
    onSeg('#segRes', (v) => { S.p.exportOpts.height = Number(v); markDirty(); });
    $('#btnExport').onclick = runExport;
    $('#btnPlayExport').onclick = () => sl.openPath($('#exportDone').dataset.path);
    $('#btnShowExport').onclick = () => sl.showInFolder($('#exportDone').dataset.path);
    $('#btnStems').onclick = () => {
      if (S.p.stems) sl.showInFolder(S.p.stems.instrumental);
      else toast('There are no stems yet. Remove the vocals in the Lyrics step first.', true);
    };

    // transport
    $('#btnPlay').onclick = togglePlay;
    $('#scrub').oninput = (e) => seek((Number(e.target.value) / 1000) * duration());
    $$('#monitor button').forEach((b) => (b.onclick = () => { if (b.disabled) return; S.monitor = b.dataset.v; setAudioSource(); }));
    $('#btnZoomIn').onclick = () => timeline.zoom(1.4);
    $('#btnZoomOut').onclick = () => timeline.zoom(1 / 1.4);
    $('#inTap').onchange = (e) => {
      $('#tlHint').textContent = e.target.checked
        ? 'Play, then hold K while each word is sung and let go when it ends. Starts from the selected word.'
        : 'Drag a word to move it, drag its edges to trim. Ctrl + wheel zooms.';
      $('#inTap').blur();
    };

    // settings
    $('#btnSettings').onclick = openSettings;
    $('#btnCloseSettings').onclick = () => { $('#settings').hidden = true; };
    $('#btnCheckEngine').onclick = checkEngine;
    $('#inDevice').onchange = (e) => sl.setSettings({ device: e.target.value });

    // keyboard
    window.addEventListener('keydown', (e) => {
      if (!$('#busy').hidden || $('#app').hidden) return;
      if (e.key === 'Escape' && !$('#settings').hidden) { $('#settings').hidden = true; return; }
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

  // ------------------------------------------------------------------ boot
  async function boot() {
    wire();
    S.p = newProject();
    fillAllFields();
    requestAnimationFrame(frame);
    initFonts();
    const info = await sl.appInfo();
    $('#welcomeFoot').textContent = `Version ${info.version}. Works offline.`;
    const pending = await sl.pendingOpen();
    if (pending) openProject(pending);
    else showWelcome();
  }
  boot();
})();
