// Scene layout shared by the live preview (canvas) and the export (ASS).
// buildScene() decides when each lyric line is on screen, where, at what size,
// and where every word sits, so preview and export put text in the same place.
(function (root, factory) {
  const api = factory(root.SLLyrics || (typeof require === 'function' ? require('./lyrics.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SLLayout = api;
})(typeof self !== 'undefined' ? self : this, function (L) {
  // Default frame (16:9). Other aspect ratios keep the short side at 1080 so
  // text sizes mean the same thing in every shape.
  const W = 1920;
  const H = 1080;
  const FADE = 0.15;
  const ASPECTS = {
    '16:9': [1920, 1080],
    '9:16': [1080, 1920],
    '1:1': [1080, 1080],
    '4:5': [1080, 1350],
  };
  function dims(aspect) { return ASPECTS[aspect] || ASPECTS['16:9']; }

  const DEFAULT_STYLE = {
    aspect: '16:9',             // 16:9 | 9:16 | 1:1 | 4:5
    layout: 'karaoke',          // karaoke | single | duet | scroll
    highlight: 'wipe',          // wipe | word | fade
    glow: false,                // neon glow on sung words
    position: 'lower',          // lower | center | upper
    font: { family: 'Segoe UI', path: '' },
    fontSize: 78,
    bold: true,
    textColor: '#FFFFFF',       // words not sung yet
    wipeColor: '#FFC24B',       // sung words (singer 1)
    wipeColor2: '#5FD4E0',      // singer 2
    wipeColor3: '#FF8FC0',      // both singers
    outlineColor: '#141833',
    outlineWidth: 4,
    shadow: true,
    countdown: true,
    showTitle: true,
    bg: { type: 'color', color: '#1E2240', path: '', dim: 0.35 },
  };

  function withDefaults(style) {
    const s = { ...DEFAULT_STYLE, ...(style || {}) };
    s.font = { ...DEFAULT_STYLE.font, ...(style && style.font) };
    s.bg = { ...DEFAULT_STYLE.bg, ...(style && style.bg) };
    return s;
  }

  function fillFor(style, singer) {
    return singer === 2 ? style.wipeColor2 : singer === 3 ? style.wipeColor3 : style.wipeColor;
  }

  function anchorY(style, H) {
    return style.position === 'center' ? H * 0.5 : style.position === 'upper' ? H * 0.27 : H * 0.76;
  }

  const maxWidth = (W, align) => W * (align === 'center' ? 0.88 : 0.8);

  // Split lyric lines that would have to shrink a lot (long lines in a narrow
  // portrait frame) into two shorter lines at the word boundary nearest the
  // middle. Each part keeps its own word timings, so the wipe is unchanged.
  function splitLong(lines, style, measure, W) {
    const out = [];
    const limit = maxWidth(W, 'center') / 0.72;
    for (const line of lines) {
      const { text } = L.joinWords(line.words);
      if (line.words.length < 2 || measure(text, style.fontSize, style.bold) <= limit) { out.push(line); continue; }
      const total = measure(text, style.fontSize, style.bold);
      let best = 1;
      let bestD = Infinity;
      for (let k = 1; k < line.words.length; k++) {
        const d = Math.abs(measure(L.joinWords(line.words.slice(0, k)).text, style.fontSize, style.bold) - total / 2);
        if (d < bestD) { bestD = d; best = k; }
      }
      const a = { ...line, words: line.words.slice(0, best), part: 1 };
      const b = { ...line, words: line.words.slice(best), part: 2 };
      out.push(...splitLong([a], style, measure, W), ...splitLong([b], style, measure, W));
    }
    return out;
  }

  // measure(text, px, bold) -> width in px. Provided by the caller (canvas).
  function placeLine(line, style, measure, y, align, W) {
    const { text, prefixes } = L.joinWords(line.words);
    const px = style.fontSize;
    const full = measure(text, px, style.bold) || 1;
    const maxW = maxWidth(W, align);
    const scale = Math.min(1, maxW / full);
    const width = full * scale;
    const margin = W * 0.08;
    const left = align === 'left' ? margin : align === 'right' ? W - margin - width : (W - width) / 2;
    const words = line.words.map((w, i) => {
      const x0 = measure(prefixes[i], px, style.bold);
      const x1 = measure(prefixes[i] + w.text, px, style.bold);
      return { text: w.text, start: w.start, end: w.end, x0: x0 * scale, x1: x1 * scale };
    });
    return { text, fontPx: px, scale, width, left, cx: left + width / 2, y, words, singer: line.singer || 1 };
  }

  function buildScene(project, measure) {
    const style = withDefaults(project.style);
    const [W, H] = dims(style.aspect);
    const lines = splitLong((project.lines || []).filter((l) => l.words && l.words.length), style, measure, W);
    const items = [];
    const n = lines.length;
    const starts = lines.map(L.lineStart);
    const ends = lines.map(L.lineEnd);
    const ay = anchorY(style, H);
    const gap = style.fontSize * 1.55;
    const twoRow = style.layout !== 'single';
    if (style.layout === 'scroll') return buildScroll(project, style, lines, measure, W, H);

    // ---- when each line is visible ----
    const appear = new Array(n);
    const hide = new Array(n);
    if (twoRow) {
      const LEAD = 3.0;
      for (let i = 0; i < n; i++) hide[i] = ends[i] + 0.35;
      for (let i = 0; i < n; i++) {
        let a = starts[i] - LEAD;
        // the second line of a pair shows up together with the first...
        if (i % 2 === 1) a = Math.min(a, appear[i - 1]);
        // ...but never before the line above it in the same row has gone
        if (i >= 2) a = Math.max(a, hide[i - 2]);
        appear[i] = Math.max(0, Math.min(a, starts[i] - 0.05));
      }
    } else {
      for (let i = 0; i < n; i++) {
        hide[i] = i + 1 < n ? Math.max(ends[i] + 0.05, Math.min(ends[i] + 1.5, starts[i + 1] - 0.3)) : ends[i] + 2.0;
      }
      for (let i = 0; i < n; i++) {
        appear[i] = Math.max(0, starts[i] - 1.0, i > 0 ? hide[i - 1] : 0);
        appear[i] = Math.min(appear[i], starts[i] - 0.05);
      }
    }

    // ---- where ----
    for (let i = 0; i < n; i++) {
      const slot = twoRow ? i % 2 : 0;
      const y = twoRow ? ay + (slot === 0 ? -gap / 2 : gap / 2) : ay;
      let align = 'center';
      if (style.layout === 'duet') {
        const sg = lines[i].singer || 1;
        align = sg === 1 ? 'left' : sg === 2 ? 'right' : 'center';
      }
      const p = placeLine(lines[i], style, measure, y, align, W);
      items.push({ kind: 'line', index: i, appear: appear[i], hide: hide[i], fadeIn: FADE, fadeOut: FADE, slot, align, fill: fillFor(style, p.singer), ...p });
    }

    // ---- countdown dots before each verse ----
    if (style.countdown) {
      for (let i = 0; i < n; i++) {
        const quiet = i === 0 ? starts[0] : starts[i] - ends[i - 1];
        if (quiet < (i === 0 ? 3.2 : 4.5)) continue;
        const from = Math.max(starts[i] - 3, i > 0 ? ends[i - 1] + 0.3 : 0);
        const firstY = twoRow ? ay - gap / 2 : ay;
        items.push({ kind: 'countdown', index: i, appear: from, hide: starts[i], start: starts[i],
          cx: W / 2, y: firstY - style.fontSize * 1.05, r: Math.max(8, style.fontSize * 0.16), fill: fillFor(style, lines[i].singer || 1) });
      }
    }

    // ---- title card during the intro ----
    if (style.showTitle && (project.title || project.artist) && n) {
      const until = Math.min(starts[0] - 3.3, 8); // gone before the countdown starts
      if (until - 0.3 >= 1.2) {
        items.push({ kind: 'title', appear: 0.3, hide: until, title: project.title || '', artist: project.artist || '',
          cx: W / 2, y: H * 0.46, fontPx: Math.round(style.fontSize * 1.25) });
      }
    }
    return { W, H, style, items, duration: project.duration || (n ? ends[n - 1] + 3 : 10) };
  }

  // ---------------------------------------------------------------------
  // Scrolling layout: the lyrics sit in a column that moves up one line each
  // time a new line starts. The current line is in focus (full size, full
  // opacity); sung lines above and upcoming lines below are smaller and dim.
  // Each line is split into one item per stretch between line changes, with
  // an explicit motion (y, opacity, size) at the start of the stretch, so the
  // preview and the ASS export move identically.
  // ---------------------------------------------------------------------
  const SCROLL = { above: 2, below: 3, trans: 0.35, dimScale: 0.8 };
  const slotAlpha = (k) => (k === 0 ? 1 : k === -1 ? 0.5 : k === -2 ? 0.25 : k === 1 ? 0.6 : k === 2 ? 0.4 : k === 3 ? 0.2 : 0);
  const slotScale = (k) => (k === 0 ? 1 : SCROLL.dimScale);

  function buildScroll(project, style, lines, measure, W, H) {
    const items = [];
    const n = lines.length;
    if (!n) return { W, H, style, items, duration: project.duration || 10 };
    const starts = lines.map(L.lineStart);
    const ends = lines.map(L.lineEnd);
    const gap = style.fontSize * 1.45;
    const focusY = style.position === 'center' ? H * 0.5 : style.position === 'upper' ? H * 0.36 : H * 0.6;
    const yOf = (k) => focusY + k * gap;
    const placed = lines.map((l) => placeLine(l, style, measure, focusY, 'center', W));

    // when the column moves to line k
    const T = [];
    for (let k = 0; k < n; k++) T.push(Math.max(k ? T[k - 1] + 0.05 : 0, starts[k] - 0.3));
    const tStart = Math.max(0, T[0] - 3);
    const tEnd = ends[n - 1] + 2;
    const bounds = [tStart, ...T, tEnd];

    for (let j = 0; j + 1 < bounds.length; j++) {
      const A = bounds[j];
      const B = bounds[j + 1];
      if (B - A < 0.02) continue;
      const c = j - 1;                           // line in focus during [A, B)
      const moving = j >= 1;                     // the column moves at A
      const tr = Math.min(SCROLL.trans, (B - A) * 0.9);
      for (let i = 0; i < n; i++) {
        const k1 = i - c;
        const k0 = moving ? i - (c - 1) : k1;
        const vis = (k) => k >= -SCROLL.above && k <= SCROLL.below;
        if (!vis(k1) && !vis(k0)) continue;
        const p = placed[i];
        items.push({
          kind: 'line', index: i, appear: A, hide: B,
          fadeIn: j === 0 ? 0.4 : 0, fadeOut: j + 2 === bounds.length ? 0.5 : 0,
          align: 'center', fill: fillFor(style, p.singer), ...p, y: yOf(k1),
          motion: {
            dur: moving ? tr : 0,
            y0: yOf(k0), y1: yOf(k1),
            a0: slotAlpha(k0), a1: slotAlpha(k1),
            s0: slotScale(k0), s1: slotScale(k1),
          },
        });
      }
    }

    // countdown dots to the left of a line that starts after a long break
    if (style.countdown) {
      for (let i = 0; i < n; i++) {
        const quiet = i === 0 ? starts[0] : starts[i] - ends[i - 1];
        if (quiet < (i === 0 ? 3.2 : 4.5)) continue;
        const from = Math.max(starts[i] - 3, i > 0 ? ends[i - 1] + 0.3 : 0, tStart);
        const r = Math.max(8, style.fontSize * 0.14);
        const p = placed[i];
        const left = p.cx - (p.width * SCROLL.dimScale) / 2;
        items.push({ kind: 'countdown', index: i, appear: from, hide: starts[i], start: starts[i],
          cx: Math.max(r * 4, left - r * 6), y: yOf(1), r, fill: fillFor(style, p.singer) });
      }
    }
    if (style.showTitle && (project.title || project.artist)) {
      const until = Math.min(tStart - 0.2, 8);
      if (until - 0.3 >= 1.2) {
        items.push({ kind: 'title', appear: 0.3, hide: until, title: project.title || '', artist: project.artist || '',
          cx: W / 2, y: H * 0.46, fontPx: Math.round(style.fontSize * 1.25) });
      }
    }
    return { W, H, style, items, duration: project.duration || tEnd + 1 };
  }

  // Motion state of an item at time t: { y, a (opacity), s (extra scale) }.
  function motionAt(item, t) {
    const m = item.motion;
    if (!m) return { y: item.y, a: 1, s: 1 };
    const k = m.dur > 0 ? Math.max(0, Math.min(1, (t - item.appear) / m.dur)) : 1;
    return { y: m.y0 + (m.y1 - m.y0) * k, a: m.a0 + (m.a1 - m.a0) * k, s: m.s0 + (m.s1 - m.s0) * k };
  }

  // Opacity of an item at time t (fades at the edges times its motion).
  function alphaAt(item, t) {
    if (t < item.appear || t > item.hide) return 0;
    const fi = item.fadeIn === undefined ? FADE : item.fadeIn;
    const fo = item.fadeOut === undefined ? FADE : item.fadeOut;
    let a = 1;
    if (fi > 0) a = Math.min(a, (t - item.appear) / fi);
    if (fo > 0) a = Math.min(a, (item.hide - t) / fo);
    return Math.max(0, a) * motionAt(item, t).a;
  }

  // Progress (0..1) of each word's highlight at time t, per highlight style.
  function wordProgress(style, word, t) {
    if (t >= word.end) return 1;
    if (t < word.start) return 0;
    if (style.highlight === 'word') return 1;
    return (t - word.start) / Math.max(0.001, word.end - word.start);
  }

  // How much of a placed line is sung at time t, in px from its left edge.
  function sungWidth(item, t) {
    let w = 0;
    for (const word of item.words) {
      if (t >= word.end) { w = word.x1; continue; }
      if (t > word.start) w = word.x0 + (word.x1 - word.x0) * ((t - word.start) / Math.max(0.001, word.end - word.start));
      break;
    }
    return w;
  }

  return { W, H, FADE, ASPECTS, dims, DEFAULT_STYLE, withDefaults, buildScene, alphaAt, motionAt, sungWidth, wordProgress, fillFor, SCROLL };
});
