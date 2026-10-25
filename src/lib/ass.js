// Build an Advanced SubStation Alpha (.ass) karaoke script from a scene.
// ffmpeg's libass renders it, giving the smooth left-to-right word wipe (\kf).
(function (root, factory) {
  const api = factory(root.SLLayout || (typeof require === 'function' ? require('./layout.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SLAss = api;
})(typeof self !== 'undefined' ? self : this, function (Layout) {
  // #RRGGBB -> &HAABBGGRR (alpha 00 = opaque)
  function col(hex, alpha = 0) {
    const h = String(hex || '#FFFFFF').replace('#', '').padEnd(6, '0');
    const a = Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase();
    return '&H' + a + h.slice(4, 6).toUpperCase() + h.slice(2, 4).toUpperCase() + h.slice(0, 2).toUpperCase();
  }
  const inlineCol = (hex) => col(hex).replace(/^&H00/, '&H') + '&';

  function ts(t) {
    const cs = Math.max(0, Math.round(t * 100));
    const h = Math.floor(cs / 360000);
    const m = Math.floor((cs % 360000) / 6000);
    const s = Math.floor((cs % 6000) / 100);
    const c = cs % 100;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
  }

  // Keep text from being read as override tags or line breaks.
  const esc = (s) => String(s).replace(/\\/g, '/').replace(/\{/g, '(').replace(/\}/g, ')');
  const r1 = (x) => Math.round(x * 10) / 10;

  // libass sizes text by (winAscent + winDescent); the browser by the em box.
  // ratio converts a CSS pixel size into the equivalent ASS Fontsize.
  function assRatio(font) {
    const m = font && font.metrics;
    return m && m.a > 0 ? m.a + m.d : 1.2;
  }

  // Karaoke text for one line: \kf syllables timed from the event start.
  function karaoke(item) {
    const t0 = item.appear;
    const cs = (t) => Math.round((t - t0) * 100);
    let cursor = 0;
    let out = '';
    item.words.forEach((w, i) => {
      const s = Math.max(cursor, cs(w.start));
      const e = Math.max(s, cs(w.end));
      if (i === 0) {
        if (s > 0) out += `{\\k${s}}`;
      }
      out += `{\\kf${e - s}}${esc(w.text)}`;
      cursor = e;
      const next = item.words[i + 1];
      if (next) {
        const ns = Math.max(cursor, cs(next.start));
        // the gap before the next word carries the space (or nothing for CJK)
        const sep = needsSpace(w.text, next.text) ? ' ' : '';
        out += `{\\k${ns - cursor}}${sep}`;
        cursor = ns;
      }
    });
    return out;
  }

  const NOSPACE = /[぀-ヿ㐀-䶿一-鿿豈-﫿฀-๿ｦ-ﾟ]/;
  function needsSpace(a, b) {
    return !(NOSPACE.test([...a].pop() || '') && NOSPACE.test([...b][0] || ''));
  }

  // Filled circle as an ASS vector drawing.
  function circle(r) {
    const k = 0.5523 * r;
    const f = (x) => Math.round(x);
    return `m 0 ${f(-r)} b ${f(k)} ${f(-r)} ${f(r)} ${f(-k)} ${f(r)} 0 b ${f(r)} ${f(k)} ${f(k)} ${f(r)} 0 ${f(r)} ` +
      `b ${f(-k)} ${f(r)} ${f(-r)} ${f(k)} ${f(-r)} 0 b ${f(-r)} ${f(-k)} ${f(-k)} ${f(-r)} 0 ${f(-r)}`;
  }

  function buildAss(scene, meta = {}) {
    const s = scene.style;
    const ratio = assRatio(s.font);
    const family = esc((s.font && s.font.family) || 'Arial').replace(/,/g, ' ');
    const bold = s.bold ? -1 : 0;
    const shadow = s.shadow ? Math.max(2, Math.round(s.fontSize * 0.045)) : 0;
    const back = col('#000000', 0.45);
    const size = (px) => r1(px * ratio);

    const head = [
      '[Script Info]',
      '; Made with SingLine Studio',
      `Title: ${esc(meta.title || 'SingLine')}`,
      'ScriptType: v4.00+',
      `PlayResX: ${scene.W}`,
      `PlayResY: ${scene.H}`,
      'WrapStyle: 2',
      'ScaledBorderAndShadow: yes',
      'YCbCr Matrix: TV.709',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: Lyric,${family},${size(s.fontSize)},${col(s.wipeColor)},${col(s.textColor)},${col(s.outlineColor)},${back},${bold},0,0,0,100,100,0,0,1,${s.outlineWidth},${shadow},5,0,0,0,1`,
      `Style: Title,${family},${size(Math.round(s.fontSize * 1.25))},${col(s.textColor)},${col(s.textColor)},${col(s.outlineColor)},${back},${bold},0,0,0,100,100,0,0,1,${s.outlineWidth},${shadow},5,0,0,0,1`,
      `Style: Dot,${family},20,${col(s.wipeColor)},${col(s.wipeColor)},${col(s.outlineColor)},${back},0,0,0,0,100,100,0,0,1,${Math.max(2, s.outlineWidth / 2)},0,5,0,0,0,1`,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];
    const ev = [];
    const fadeMs = Math.round(Layout.FADE * 1000);

    for (const it of scene.items) {
      if (it.kind === 'line') {
        const sc = r1(it.scale * 100);
        const tags = `\\an5\\pos(${r1(it.cx)},${r1(it.y)})\\fscx${sc}\\fscy${sc}\\fad(${fadeMs},${fadeMs})\\1c${inlineCol(it.fill)}`;
        ev.push(`Dialogue: 1,${ts(it.appear)},${ts(it.hide)},Lyric,,0,0,0,,{${tags}}${karaoke(it)}`);
      } else if (it.kind === 'countdown') {
        // three dots that go out one per second: 3, 2, 1, sing
        const spacing = it.r * 3.2;
        for (let k = 0; k < 3; k++) {
          const end = it.start - (2 - k);
          if (end <= it.appear) continue;
          const x = it.cx + (k - 1) * spacing;
          ev.push(`Dialogue: 0,${ts(it.appear)},${ts(end)},Dot,,0,0,0,,{\\an5\\pos(${r1(x)},${r1(it.y)})\\1c${inlineCol(it.fill)}\\p1}${circle(it.r)}{\\p0}`);
        }
      } else if (it.kind === 'title') {
        const tf = `\\an5\\fad(400,400)`;
        if (it.title) ev.push(`Dialogue: 0,${ts(it.appear)},${ts(it.hide)},Title,,0,0,0,,{${tf}\\pos(${r1(it.cx)},${r1(it.y)})}${esc(it.title)}`);
        if (it.artist) {
          ev.push(`Dialogue: 0,${ts(it.appear)},${ts(it.hide)},Title,,0,0,0,,{${tf}\\pos(${r1(it.cx)},${r1(it.y + it.fontPx * 0.95)})\\fs${size(Math.round(it.fontPx * 0.55))}\\b0}${esc(it.artist)}`);
        }
      }
    }
    return head.join('\n') + '\n' + ev.join('\n') + '\n';
  }

  return { buildAss, col, ts, assRatio };
});
