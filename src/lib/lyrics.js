// Lyrics helpers shared by the UI, preview and export. Works in the browser
// (window.SLLyrics) and in Node (module.exports) for tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SLLyrics = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Scripts written without spaces between words: CJK, kana, Thai.
  const NOSPACE = /[぀-ヿ㐀-䶿一-鿿豈-﫿฀-๿ｦ-ﾟ]/;
  const PUNCT = /\p{P}/u;

  // Must match tokenize() in worker/worker.py.
  function tokenize(line) {
    const tokens = [];
    for (const chunk of String(line).split(/\s+/).filter(Boolean)) {
      if (!NOSPACE.test(chunk)) { tokens.push(chunk); continue; }
      let cur = '';
      for (const ch of chunk) {
        if (NOSPACE.test(ch)) {
          if (cur) tokens.push(cur);
          cur = ch;
        } else if (PUNCT.test(ch) && cur) {
          cur += ch;
        } else {
          if (cur && NOSPACE.test([...cur].pop())) { tokens.push(cur); cur = ''; }
          cur += ch;
        }
      }
      if (cur) tokens.push(cur);
    }
    return tokens;
  }

  const isNoSpace = (t) => NOSPACE.test(t);

  // Join word tokens back into display text. Returns the text plus, for each
  // word, the text before it (used to measure word positions).
  function joinWords(words) {
    let text = '';
    const prefixes = [];
    words.forEach((w, i) => {
      if (i > 0) {
        const prev = words[i - 1].text;
        const glue = isNoSpace([...prev].pop() || '') && isNoSpace([...w.text][0] || '') ? '' : ' ';
        text += glue;
      }
      prefixes.push(text);
      text += w.text;
    });
    return { text, prefixes };
  }

  const lineText = (line) => joinWords(line.words).text;
  const lineStart = (line) => (line.words.length ? line.words[0].start : 0);
  const lineEnd = (line) => (line.words.length ? line.words[line.words.length - 1].end : 0);

  // Re-time a line after its text was edited: keep the line's time span and
  // reuse old word timings where words still line up, else spread evenly.
  function retimeLine(line, newText) {
    const tokens = tokenize(newText);
    if (!tokens.length) return { ...line, words: [] };
    const s = lineStart(line);
    const e = Math.max(lineEnd(line), s + 0.3 * tokens.length);
    if (tokens.length === line.words.length) {
      return { ...line, words: line.words.map((w, i) => ({ ...w, text: tokens[i] })) };
    }
    const weights = tokens.map((t) => Math.max(1, [...t].length));
    const total = weights.reduce((a, b) => a + b, 0);
    let t = s;
    const words = tokens.map((text, i) => {
      const d = ((e - s) * weights[i]) / total;
      const w = { text, start: round3(t), end: round3(t + d) };
      t += d;
      return w;
    });
    return { ...line, words };
  }

  // Lines with no timing yet (pasted before any sync): spread across a span.
  function untimedLines(texts, from, to) {
    const lines = texts.map((t) => t.trim()).filter(Boolean).map((t) => ({ singer: 1, words: tokenize(t).map((text) => ({ text, start: 0, end: 0 })) }));
    const n = lines.reduce((a, l) => a + l.words.length, 0) || 1;
    const step = Math.max(0.2, (to - from) / n);
    let t = from;
    lines.forEach((l) => l.words.forEach((w) => { w.start = round3(t); w.end = round3(t + step * 0.9); t += step; }));
    return lines;
  }

  function round3(x) { return Math.round(x * 1000) / 1000; }

  // Keep every word ordered, non-overlapping and at least 40 ms long.
  function normalize(lines) {
    let prev = 0;
    for (const l of lines) {
      for (const w of l.words) {
        w.start = round3(Math.max(w.start, prev));
        w.end = round3(Math.max(w.end, w.start + 0.04));
        prev = w.end;
      }
    }
    return lines;
  }

  // ---- timeline editing ----
  function shiftLine(line, dt) {
    for (const w of line.words) { w.start = round3(w.start + dt); w.end = round3(w.end + dt); }
  }

  // Stretch or squeeze a line to a new [start, end], keeping word proportions.
  function scaleLine(line, start, end, ref) {
    const r0 = ref.start;
    const r1 = Math.max(ref.end, r0 + 0.01);
    const k = (end - start) / (r1 - r0);
    line.words.forEach((w, i) => {
      w.start = round3(start + (ref.words[i].start - r0) * k);
      w.end = round3(start + (ref.words[i].end - r0) * k);
    });
  }

  // After a line was dragged somewhere (possibly past other lines): put it in
  // time order and push its neighbours out of the way so nothing overlaps.
  // The dropped line stays exactly where it was put. Returns its new index.
  function dropLine(lines, idx, duration) {
    const moved = lines[idx];
    lines.splice(idx, 1);
    let at = lines.findIndex((l) => lineStart(l) > lineStart(moved));
    if (at < 0) at = lines.length;
    lines.splice(at, 0, moved);
    const GAP = 0.02;
    // later lines: ripple forward
    for (let i = at + 1; i < lines.length; i++) {
      const over = lineEnd(lines[i - 1]) + GAP - lineStart(lines[i]);
      if (over <= 0) break;
      shiftLine(lines[i], over);
    }
    // earlier lines: ripple backward, but never before 0
    for (let i = at - 1; i >= 0; i--) {
      const over = lineEnd(lines[i]) + GAP - lineStart(lines[i + 1]);
      if (over <= 0) break;
      shiftLine(lines[i], -Math.min(over, lineStart(lines[i])));
    }
    // if the start of the song was in the way, the dropped line yields
    for (let i = 1; i < lines.length; i++) {
      const over = lineEnd(lines[i - 1]) + GAP - lineStart(lines[i]);
      if (over > 0) shiftLine(lines[i], over);
    }
    if (duration) {
      const last = lines[lines.length - 1];
      const past = lineEnd(last) - duration;
      if (past > 0) shiftLine(last, -Math.min(past, lineStart(last) - (lines.length > 1 ? lineEnd(lines[lines.length - 2]) : 0)));
    }
    return at;
  }

  // Move/trim one word; neighbours are pushed along instead of blocking it.
  // flat: all words in order; k: index of the word that changed.
  function pushNeighbours(flat, k, minLen = 0.04) {
    for (let i = k + 1; i < flat.length; i++) {
      const over = flat[i - 1].end - flat[i].start;
      if (over <= 0) break;
      flat[i].start = round3(flat[i].start + over);
      flat[i].end = round3(Math.max(flat[i].end + over, flat[i].start + minLen));
    }
    for (let i = k - 1; i >= 0; i--) {
      const over = flat[i].end - flat[i + 1].start;
      if (over <= 0) break;
      flat[i].end = round3(flat[i].end - over);
      flat[i].start = round3(Math.min(flat[i].start - over, flat[i].end - minLen));
    }
  }

  // Replace one word's text; several words typed in its place share its time.
  function replaceWord(line, wi, text) {
    const toks = tokenize(text);
    const w = line.words[wi];
    if (!toks.length) { line.words.splice(wi, 1); return; }
    const weights = toks.map((t) => Math.max(1, [...t].length));
    const total = weights.reduce((a, b) => a + b, 0);
    let t = w.start;
    const parts = toks.map((tok, i) => {
      const d = ((w.end - w.start) * weights[i]) / total;
      const o = { text: tok, start: round3(t), end: round3(t + d) };
      t += d;
      return o;
    });
    line.words.splice(wi, 1, ...parts);
  }

  function fromWorker(lines) {
    return normalize(lines.map((l) => ({ singer: 1, words: l.words.map((w) => ({ text: w.text, start: w.start, end: w.end })) })));
  }

  function fmtTime(t, ms = true) {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return m + ':' + (ms ? s.toFixed(2).padStart(5, '0') : String(Math.floor(s)).padStart(2, '0'));
  }

  return { tokenize, joinWords, lineText, lineStart, lineEnd, retimeLine, untimedLines, normalize, fromWorker, fmtTime, round3,
    shiftLine, scaleLine, dropLine, pushNeighbours, replaceWord };
});
