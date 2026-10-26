// Sync timeline. Tracks, top to bottom: ruler, vocal waveform, lyric lines,
// words, background.
//   Lines: drag to move a whole line anywhere (even past other lines),
//          drag an edge to stretch or squeeze it, double-click to edit text.
//   Words: drag to move (neighbours get pushed along), drag an edge to trim,
//          double-click to edit the word.
//   Dragging near the left or right edge scrolls the timeline.
//   Click empty space to seek, wheel to scroll, Ctrl+wheel to zoom.
(function (root) {
  const L = () => root.SLLyrics;
  const RULER = 22;
  const WAVE = 54;
  const LINES = 30;
  const WORDS = 34;
  const BGT = 24;
  const Y_LINES = RULER + WAVE + 2;
  const Y_WORDS = Y_LINES + LINES + 2;
  const Y_BG = Y_WORDS + WORDS + 2;
  const EDGE = 6;
  const AUTOSCROLL_ZONE = 48;
  const MINPPS = 15;
  const MAXPPS = 900;

  class Timeline {
    constructor(canvas, cb) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      // cb: getLines, getTime, getDuration, getBgLabel, onSeek, onSelect,
      //     onEditStart, onEdit, onEditEnd(moved), onLineDrop(li), onEditText({kind, li, wi, rect}), onZoom
      this.cb = cb;
      this.pps = 120;
      this.x0 = 0;
      this.peaks = null;
      this.sel = null;     // { li, wi } (wi = -1 when a whole line is selected)
      this.drag = null;
      this.follow = true;
      this.lastPointer = null;
      this.scrollRaf = 0;
      this.readColors();
      new ResizeObserver(() => this.resize()).observe(canvas);
      canvas.addEventListener('pointerdown', (e) => this.down(e));
      canvas.addEventListener('pointermove', (e) => this.move(e));
      canvas.addEventListener('pointerup', (e) => this.up(e));
      canvas.addEventListener('pointercancel', (e) => this.up(e));
      canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
      canvas.addEventListener('dblclick', (e) => this.dbl(e));
      this.resize();
    }

    readColors() {
      const cs = getComputedStyle(document.documentElement);
      const v = (n, d) => (cs.getPropertyValue(n).trim() || d);
      this.colors = {
        bg: v('--tl-bg', '#181b35'), grid: v('--line', '#363c6b'), text: v('--muted', '#a8acd6'),
        wave: v('--tl-wave', '#4a5190'), word: v('--tl-word', '#2f356a'), wordText: v('--ink', '#eef0ff'),
        sel: v('--cyan', '#5fd4e0'), head: v('--amber', '#ffc24b'), sung: v('--tl-sung', '#5a4a2a'),
        bgTrack: v('--tl-bgtrack', '#3b2f5e'), line: v('--tl-line', '#5b3fa0'), lineHi: v('--tl-line-hi', '#7353c4'),
      };
    }

    resize() {
      const r = this.cv.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.w = Math.max(100, r.width);
      this.h = Y_BG + BGT + 6;
      this.cv.style.height = this.h + 'px';
      this.cv.width = Math.round(this.w * dpr);
      this.cv.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    }

    setPeaks(p) { this.peaks = p; this.draw(); }
    tx(t) { return (t - this.x0) * this.pps; }
    xt(x) { return this.x0 + x / this.pps; }

    clampView() {
      const dur = this.cb.getDuration() || 1;
      const maxX0 = Math.max(0, dur - this.w / this.pps + 0.5);
      this.x0 = Math.max(0, Math.min(maxX0, this.x0));
    }

    followTime(t) {
      if (!this.follow || this.drag) return;
      const span = this.w / this.pps;
      if (t < this.x0 || t > this.x0 + span * 0.85) { this.x0 = t - span * 0.15; this.clampView(); }
    }

    reveal(t) {
      const span = this.w / this.pps;
      if (t < this.x0 + span * 0.05 || t > this.x0 + span * 0.9) { this.x0 = t - span * 0.3; this.clampView(); }
      this.draw();
    }

    zoom(f, atX) { this.setPps(this.pps * f, atX); }
    setPps(pps, atX) {
      const ax = atX === undefined ? this.tx(this.cb.getTime()) : atX;
      const anchor = ax >= 0 && ax <= this.w ? ax : this.w / 2;
      const t = this.xt(anchor);
      this.pps = Math.max(MINPPS, Math.min(MAXPPS, pps));
      this.x0 = t - anchor / this.pps;
      this.clampView();
      this.draw();
      if (this.cb.onZoom) this.cb.onZoom(this.zoomFrac());
    }
    zoomFrac() { return Math.log(this.pps / MINPPS) / Math.log(MAXPPS / MINPPS); }
    setZoomFrac(f) { this.setPps(MINPPS * Math.pow(MAXPPS / MINPPS, Math.max(0, Math.min(1, f)))); }

    // ---------- hit testing ----------
    pos(e) {
      const r = this.cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    edgePart(x, a, b) {
      if (b - a > EDGE * 3) return x < a + EDGE ? 'start' : x > b - EDGE ? 'end' : 'body';
      return x < a ? 'start' : x > b ? 'end' : 'body';
    }

    hit(e) {
      const { x, y } = this.pos(e);
      const t = this.xt(x);
      const lines = this.cb.getLines();
      if (y >= Y_LINES && y < Y_LINES + LINES) {
        // later lines are drawn on top, so test them first
        for (let li = lines.length - 1; li >= 0; li--) {
          const l = lines[li];
          if (!l.words.length) continue;
          const a = this.tx(L().lineStart(l));
          const b = this.tx(L().lineEnd(l));
          if (x >= a - EDGE && x <= b + EDGE) return { t, x, y, area: 'lines', li, part: this.edgePart(x, a, b), a, b };
        }
        return { t, x, y, area: 'lines' };
      }
      if (y >= Y_WORDS && y < Y_WORDS + WORDS) {
        for (let li = 0; li < lines.length; li++) {
          const ws = lines[li].words;
          for (let wi = 0; wi < ws.length; wi++) {
            const a = this.tx(ws[wi].start);
            const b = this.tx(ws[wi].end);
            if (x >= a - EDGE && x <= b + EDGE) return { t, x, y, area: 'words', li, wi, word: ws[wi], part: this.edgePart(x, a, b), a, b };
          }
        }
        return { t, x, y, area: 'words' };
      }
      return { t, x, y, area: 'other' };
    }

    flat() {
      const out = [];
      this.cb.getLines().forEach((l, li) => l.words.forEach((w, wi) => out.push({ li, wi, w })));
      return out;
    }

    // ---------- pointer ----------
    down(e) {
      if (e.button !== 0) return;
      this.cv.setPointerCapture(e.pointerId);
      this.lastPointer = e;
      const h = this.hit(e);
      const lines = this.cb.getLines();
      if (h.area === 'lines' && h.li !== undefined) {
        const l = lines[h.li];
        this.sel = { li: h.li, wi: -1 };
        this.cb.onSelect(this.sel);
        this.drag = {
          kind: 'line-' + h.part, li: h.li, t0: h.t, moved: false,
          ref: { start: L().lineStart(l), end: L().lineEnd(l), words: l.words.map((w) => ({ start: w.start, end: w.end })) },
        };
        this.cb.onEditStart();
      } else if (h.word) {
        this.sel = { li: h.li, wi: h.wi };
        this.cb.onSelect(this.sel);
        const flat = this.flat();
        const k = flat.findIndex((f) => f.li === h.li && f.wi === h.wi);
        this.drag = {
          kind: 'word-' + h.part, k, t0: h.t, moved: false,
          ref: flat.map((f) => ({ start: f.w.start, end: f.w.end })),
        };
        this.cb.onEditStart();
      } else {
        this.drag = { kind: 'seek' };
        this.cb.onSeek(Math.max(0, h.t));
      }
      this.draw();
    }

    move(e) {
      if (!this.drag) {
        const h = this.hit(e);
        const over = h.area === 'lines' ? h.li !== undefined : !!h.word;
        this.cv.style.cursor = over ? (h.part === 'body' ? 'grab' : 'ew-resize') : 'default';
        return;
      }
      this.lastPointer = e;
      this.applyDrag(e);
      this.autoscroll(e);
    }

    applyDrag(e) {
      const d = this.drag;
      if (!d) return;
      const h = this.hit(e);
      if (d.kind === 'seek') { this.cb.onSeek(Math.max(0, h.t)); return; }
      const dt = h.t - d.t0;
      if (Math.abs(dt) > 0.003) d.moved = true;
      const dur = this.cb.getDuration() || 1e9;
      const lines = this.cb.getLines();

      if (d.kind.startsWith('line-')) {
        const l = lines[d.li];
        const r = d.ref;
        if (d.kind === 'line-body') {
          const s = clamp(r.start + dt, 0, dur - (r.end - r.start));
          L().scaleLine(l, s, s + (r.end - r.start), r);
        } else if (d.kind === 'line-start') {
          L().scaleLine(l, clamp(r.start + dt, 0, r.end - 0.08 * l.words.length), r.end, r);
        } else {
          L().scaleLine(l, r.start, clamp(r.end + dt, r.start + 0.08 * l.words.length, dur), r);
        }
      } else {
        // restore everything, then apply the change and push neighbours
        const flat = this.flat();
        flat.forEach((f, i) => { f.w.start = d.ref[i].start; f.w.end = d.ref[i].end; });
        const w = flat[d.k].w;
        const r = d.ref[d.k];
        const len = r.end - r.start;
        if (d.kind === 'word-body') {
          const s = clamp(r.start + dt, 0, dur - len);
          w.start = s; w.end = s + len;
        } else if (d.kind === 'word-start') {
          w.start = clamp(r.start + dt, 0, r.end - 0.04);
        } else {
          w.end = clamp(r.end + dt, r.start + 0.04, dur);
        }
        L().pushNeighbours(flat.map((f) => f.w), d.k);
      }
      this.cb.onEdit();
      this.draw();
    }

    // Keep scrolling while the pointer is held near an edge during a drag.
    autoscroll(e) {
      const { x } = this.pos(e);
      const speed = x < AUTOSCROLL_ZONE ? -(AUTOSCROLL_ZONE - x) : x > this.w - AUTOSCROLL_ZONE ? x - (this.w - AUTOSCROLL_ZONE) : 0;
      if (!speed || this.drag.kind === 'seek') { cancelAnimationFrame(this.scrollRaf); this.scrollRaf = 0; return; }
      if (this.scrollRaf) return;
      const step = () => {
        if (!this.drag || !this.lastPointer) { this.scrollRaf = 0; return; }
        const p = this.pos(this.lastPointer);
        const v = p.x < AUTOSCROLL_ZONE ? -(AUTOSCROLL_ZONE - p.x) : p.x > this.w - AUTOSCROLL_ZONE ? p.x - (this.w - AUTOSCROLL_ZONE) : 0;
        if (!v) { this.scrollRaf = 0; return; }
        const before = this.x0;
        this.x0 += (Math.sign(v) * Math.min(1, Math.abs(v) / AUTOSCROLL_ZONE) * 12) / this.pps;
        this.clampView();
        if (this.x0 !== before) this.applyDrag(this.lastPointer);
        this.scrollRaf = requestAnimationFrame(step);
      };
      this.scrollRaf = requestAnimationFrame(step);
    }

    up(e) {
      try { this.cv.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = 0;
      const d = this.drag;
      this.drag = null;
      if (!d || d.kind === 'seek') return;
      if (d.kind.startsWith('line-') && d.moved) {
        const at = this.cb.onLineDrop(d.li);
        this.sel = { li: at, wi: -1 };
        this.cb.onSelect(this.sel);
      }
      this.cb.onEditEnd(d.moved);
      this.draw();
    }

    dbl(e) {
      const h = this.hit(e);
      const top = h.area === 'lines' ? Y_LINES : Y_WORDS;
      const height = h.area === 'lines' ? LINES - 4 : WORDS - 6;
      if (h.area === 'lines' && h.li !== undefined) {
        this.cb.onEditText({ kind: 'line', li: h.li, rect: { x: h.a, y: top, w: h.b - h.a, h: height } });
      } else if (h.word) {
        this.cb.onEditText({ kind: 'word', li: h.li, wi: h.wi, rect: { x: h.a, y: top, w: h.b - h.a, h: height } });
      }
    }

    wheel(e) {
      e.preventDefault();
      if (e.ctrlKey) {
        this.zoom(e.deltaY < 0 ? 1.18 : 1 / 1.18, this.pos(e).x);
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        this.x0 += d / this.pps;
        this.follow = false;
        clearTimeout(this._ft);
        this._ft = setTimeout(() => { this.follow = true; }, 2500);
        this.clampView();
        this.draw();
      }
    }

    // ---------- drawing ----------
    label(c, text, a, y, wpx, hpx, color) {
      if (wpx <= 14) return;
      c.save();
      c.beginPath(); c.rect(a + 3, y, wpx - 6, hpx); c.clip();
      c.fillStyle = color;
      c.fillText(text, a + 6, y + hpx / 2);
      c.restore();
    }

    draw() {
      const c = this.ctx;
      const C = this.colors;
      const { w, h } = this;
      c.clearRect(0, 0, w, h);
      c.fillStyle = C.bg;
      c.fillRect(0, 0, w, h);
      const t1 = this.xt(w);

      // ruler
      const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
      const step = steps.find((s) => s * this.pps >= 70) || 60;
      c.font = '11px "Segoe UI", sans-serif';
      c.textBaseline = 'middle';
      for (let t = Math.floor(this.x0 / step) * step; t < t1; t += step) {
        const x = Math.round(this.tx(t)) + 0.5;
        c.strokeStyle = C.grid;
        c.beginPath(); c.moveTo(x, RULER - 6); c.lineTo(x, h); c.stroke();
        c.fillStyle = C.text;
        c.fillText(L().fmtTime(t, step < 1), x + 4, RULER / 2);
      }

      // waveform
      if (this.peaks && this.peaks.length) {
        const mid = RULER + WAVE / 2;
        c.fillStyle = C.wave;
        for (let x = 0; x < w; x++) {
          const a = Math.floor(this.xt(x) * 100);
          const b = Math.max(a + 1, Math.floor(this.xt(x + 1) * 100));
          let m = 0;
          for (let i = Math.max(0, a); i < Math.min(this.peaks.length, b); i++) if (this.peaks[i] > m) m = this.peaks[i];
          const hh = Math.max(1, m * (WAVE - 8));
          c.fillRect(x, mid - hh / 2, 1, hh);
        }
      } else {
        c.fillStyle = C.text;
        c.fillText('No vocal track: the waveform shows here when there is one.', 12, RULER + WAVE / 2);
      }

      const now = this.cb.getTime();
      const lines = this.cb.getLines();
      const dragging = this.drag && this.drag.kind.startsWith('line-') ? this.drag.li : -1;

      // line blocks (the one being dragged is drawn last, on top)
      c.font = '600 12px "Segoe UI", sans-serif';
      const order = lines.map((_, i) => i).filter((i) => i !== dragging);
      if (dragging >= 0) order.push(dragging);
      for (const li of order) {
        const l = lines[li];
        if (!l.words.length) continue;
        const s = L().lineStart(l);
        const e2 = L().lineEnd(l);
        if (e2 < this.x0 || s > t1) continue;
        const a = this.tx(s);
        const b = this.tx(e2);
        const isSel = this.sel && this.sel.li === li && this.sel.wi === -1;
        const active = now >= s && now <= e2;
        c.globalAlpha = li === dragging ? 0.92 : 1;
        c.fillStyle = active || isSel ? C.lineHi : C.line;
        roundRect(c, a, Y_LINES, Math.max(3, b - a - 1), LINES - 4, 5);
        c.fill();
        c.globalAlpha = 1;
        if (isSel || li === dragging) { c.strokeStyle = C.sel; c.lineWidth = 2; roundRect(c, a, Y_LINES, Math.max(3, b - a - 1), LINES - 4, 5); c.stroke(); c.lineWidth = 1; }
        this.label(c, L().lineText(l), a, Y_LINES, b - a, LINES - 4, C.wordText);
      }

      // word blocks
      c.font = '12px "Segoe UI", sans-serif';
      lines.forEach((l, li) => {
        l.words.forEach((wd, wi) => {
          if (wd.end < this.x0 || wd.start > t1) return;
          const a = this.tx(wd.start);
          const b = this.tx(wd.end);
          const isSel = this.sel && this.sel.li === li && (this.sel.wi === wi || this.sel.wi === -1);
          c.fillStyle = now >= wd.start && now <= wd.end ? C.sung : C.word;
          roundRect(c, a, Y_WORDS, Math.max(2, b - a - 1), WORDS - 6, 4);
          c.fill();
          if (wi === 0) { c.fillStyle = C.head; c.fillRect(a, Y_WORDS - 1, 2, WORDS - 4); }
          if (isSel) { c.strokeStyle = C.sel; c.lineWidth = this.sel.wi === -1 ? 1 : 2; roundRect(c, a, Y_WORDS, Math.max(2, b - a - 1), WORDS - 6, 4); c.stroke(); c.lineWidth = 1; }
          this.label(c, wd.text, a, Y_WORDS, b - a, WORDS - 6, C.wordText);
        });
      });

      // background track
      const dur = this.cb.getDuration() || 0;
      if (dur > 0) {
        const a = Math.max(0, this.tx(0));
        const b = Math.min(w, this.tx(dur));
        if (b > a) {
          c.fillStyle = C.bgTrack;
          roundRect(c, a, Y_BG, b - a, BGT - 4, 4);
          c.fill();
          c.font = '11.5px "Segoe UI", sans-serif';
          this.label(c, (this.cb.getBgLabel && this.cb.getBgLabel()) || 'Background', Math.max(a, 0), Y_BG, b - Math.max(a, 0), BGT - 4, C.wordText);
        }
      }

      // auto-scroll hint while dragging
      if (this.drag && this.drag.kind !== 'seek') {
        const g1 = c.createLinearGradient(0, 0, AUTOSCROLL_ZONE, 0);
        g1.addColorStop(0, 'rgba(255,194,75,.18)'); g1.addColorStop(1, 'rgba(255,194,75,0)');
        c.fillStyle = g1; c.fillRect(0, Y_LINES, AUTOSCROLL_ZONE, LINES + WORDS + 2);
        const g2 = c.createLinearGradient(w - AUTOSCROLL_ZONE, 0, w, 0);
        g2.addColorStop(0, 'rgba(255,194,75,0)'); g2.addColorStop(1, 'rgba(255,194,75,.18)');
        c.fillStyle = g2; c.fillRect(w - AUTOSCROLL_ZONE, Y_LINES, AUTOSCROLL_ZONE, LINES + WORDS + 2);
      }

      // playhead
      const px = Math.round(this.tx(now)) + 0.5;
      if (px >= 0 && px <= w) {
        c.strokeStyle = C.head; c.lineWidth = 2;
        c.beginPath(); c.moveTo(px, 0); c.lineTo(px, h); c.stroke();
        c.lineWidth = 1;
      }
    }
  }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function roundRect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  root.SLTimeline = Timeline;
})(self);
