// Sync timeline: waveform + one block per word. Drag a block to move it, drag
// its edges to trim, wheel to scroll, Ctrl+wheel to zoom, click to seek.
(function (root) {
  const RULER = 22;
  const WAVE = 64;
  const WORDS = 40;
  const BGT = 26;      // background track
  const EDGE = 6;
  const MINPPS = 15;
  const MAXPPS = 900;

  class Timeline {
    constructor(canvas, cb) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.cb = cb; // { getLines, getTime, getDuration, onSeek, onSelect, onEditStart, onEdit, onEditEnd }
      this.pps = 120;      // pixels per second
      this.x0 = 0;         // seconds at left edge
      this.peaks = null;
      this.sel = null;     // { li, wi }
      this.drag = null;
      this.follow = true;
      this.colors = {};
      this.readColors();
      new ResizeObserver(() => this.resize()).observe(canvas);
      canvas.addEventListener('pointerdown', (e) => this.down(e));
      canvas.addEventListener('pointermove', (e) => this.move(e));
      canvas.addEventListener('pointerup', (e) => this.up(e));
      canvas.addEventListener('pointercancel', (e) => this.up(e));
      canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
      canvas.addEventListener('dblclick', (e) => {
        const hit = this.hit(e);
        if (hit && hit.word) this.cb.onSeek(hit.word.start - 0.4);
      });
      this.resize();
    }

    readColors() {
      const cs = getComputedStyle(document.documentElement);
      const v = (n, d) => (cs.getPropertyValue(n).trim() || d);
      this.colors = {
        bg: v('--tl-bg', '#181b35'), grid: v('--line', '#363c6b'), text: v('--muted', '#a8acd6'),
        wave: v('--tl-wave', '#4a5190'), word: v('--tl-word', '#2f356a'), wordText: v('--ink', '#eef0ff'),
        sel: v('--cyan', '#5fd4e0'), head: v('--amber', '#ffc24b'), sung: v('--tl-sung', '#5a4a2a'),
        bgTrack: v('--tl-bgtrack', '#3b2f5e'),
      };
    }

    resize() {
      const r = this.cv.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.w = Math.max(100, r.width);
      this.h = RULER + WAVE + WORDS + BGT + 10;
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

    // Keep the playhead in view while playing.
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

    // 0..1 on a log scale, for the zoom slider
    zoomFrac() { return Math.log(this.pps / MINPPS) / Math.log(MAXPPS / MINPPS); }
    setZoomFrac(f) { this.setPps(MINPPS * Math.pow(MAXPPS / MINPPS, Math.max(0, Math.min(1, f)))); }

    // ---------- hit testing ----------
    hit(e) {
      const r = this.cv.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const t = this.xt(x);
      if (y < RULER + WAVE || y > RULER + WAVE + WORDS) return { t, x, y, area: 'wave' };
      const lines = this.cb.getLines();
      for (let li = 0; li < lines.length; li++) {
        const ws = lines[li].words;
        for (let wi = 0; wi < ws.length; wi++) {
          const w = ws[wi];
          const a = this.tx(w.start);
          const b = this.tx(w.end);
          if (x >= a - EDGE && x <= b + EDGE) {
            let part = 'body';
            if (b - a > EDGE * 3) {
              if (x < a + EDGE) part = 'start';
              else if (x > b - EDGE) part = 'end';
            } else if (x < a) part = 'start';
            else if (x > b) part = 'end';
            return { t, x, y, area: 'words', li, wi, word: w, part };
          }
        }
      }
      return { t, x, y, area: 'words' };
    }

    neighbours(li, wi) {
      const lines = this.cb.getLines();
      const flat = [];
      lines.forEach((l, a) => l.words.forEach((w, b) => flat.push({ a, b, w })));
      const k = flat.findIndex((f) => f.a === li && f.b === wi);
      return { prev: k > 0 ? flat[k - 1].w : null, next: k < flat.length - 1 ? flat[k + 1].w : null };
    }

    down(e) {
      this.cv.setPointerCapture(e.pointerId);
      const h = this.hit(e);
      if (h.word) {
        this.sel = { li: h.li, wi: h.wi };
        this.cb.onSelect(this.sel);
        const { prev, next } = this.neighbours(h.li, h.wi);
        this.drag = { kind: h.part, li: h.li, wi: h.wi, t0: h.t, s0: h.word.start, e0: h.word.end, prev, next, moved: false };
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
        this.cv.style.cursor = h.word ? (h.part === 'body' ? 'grab' : 'ew-resize') : 'text';
        return;
      }
      const h = this.hit(e);
      const d = this.drag;
      if (d.kind === 'seek') { this.cb.onSeek(Math.max(0, h.t)); return; }
      const w = this.cb.getLines()[d.li].words[d.wi];
      const dt = h.t - d.t0;
      if (Math.abs(dt) > 0.003) d.moved = true;
      const lo = d.prev ? d.prev.start + 0.04 : 0;
      const hi = d.next ? d.next.end - 0.04 : (this.cb.getDuration() || 1e9);
      if (d.kind === 'start') {
        w.start = clamp(d.s0 + dt, lo, w.end - 0.04);
        if (d.prev && d.prev.end > w.start) d.prev.end = w.start;
      } else if (d.kind === 'end') {
        w.end = clamp(d.e0 + dt, w.start + 0.04, hi);
        if (d.next && d.next.start < w.end) d.next.start = w.end;
      } else {
        const len = d.e0 - d.s0;
        const loB = d.prev ? d.prev.start + 0.04 : 0;
        const hiB = d.next ? d.next.end - 0.04 - len : hi - len;
        const s = clamp(d.s0 + dt, loB, hiB);
        w.start = s; w.end = s + len;
        if (d.prev && d.prev.end > w.start) d.prev.end = w.start;
        if (d.next && d.next.start < w.end) d.next.start = w.end;
      }
      this.cb.onEdit();
      this.draw();
    }

    up(e) {
      try { this.cv.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (this.drag && this.drag.kind !== 'seek') this.cb.onEditEnd(this.drag.moved);
      this.drag = null;
    }

    wheel(e) {
      e.preventDefault();
      if (e.ctrlKey) {
        const r = this.cv.getBoundingClientRect();
        this.zoom(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX - r.left);
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
    draw() {
      const c = this.ctx;
      const C = this.colors;
      const { w, h } = this;
      c.clearRect(0, 0, w, h);
      c.fillStyle = C.bg;
      c.fillRect(0, 0, w, h);
      const t1 = this.xt(w);

      // ruler with adaptive tick spacing
      const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
      const step = steps.find((s) => s * this.pps >= 70) || 60;
      c.font = '11px "Segoe UI", sans-serif';
      c.textBaseline = 'middle';
      for (let t = Math.floor(this.x0 / step) * step; t < t1; t += step) {
        const x = Math.round(this.tx(t)) + 0.5;
        c.strokeStyle = C.grid;
        c.beginPath(); c.moveTo(x, RULER - 6); c.lineTo(x, h); c.stroke();
        c.fillStyle = C.text;
        c.fillText(root.SLLyrics.fmtTime(t, step < 1), x + 4, RULER / 2);
      }

      // waveform of the vocals
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
        c.fillText('The vocal waveform appears here after vocals are removed.', 12, RULER + WAVE / 2);
      }

      // word blocks
      const y = RULER + WAVE + 2;
      const now = this.cb.getTime();
      const lines = this.cb.getLines();
      c.font = '12px "Segoe UI", sans-serif';
      lines.forEach((l, li) => {
        l.words.forEach((wd, wi) => {
          if (wd.end < this.x0 || wd.start > t1) return;
          const a = this.tx(wd.start);
          const b = this.tx(wd.end);
          const isSel = this.sel && this.sel.li === li && this.sel.wi === wi;
          c.fillStyle = now >= wd.start && now <= wd.end ? C.sung : C.word;
          roundRect(c, a, y, Math.max(2, b - a - 1), WORDS - 6, 4);
          c.fill();
          if (wi === 0) { // line start marker
            c.fillStyle = C.head;
            c.fillRect(a, y - 2, 2, WORDS - 2);
          }
          if (isSel) { c.strokeStyle = C.sel; c.lineWidth = 2; roundRect(c, a, y, Math.max(2, b - a - 1), WORDS - 6, 4); c.stroke(); }
          if (b - a > 14) {
            c.save();
            c.beginPath(); c.rect(a + 3, y, b - a - 6, WORDS - 6); c.clip();
            c.fillStyle = C.wordText;
            c.fillText(wd.text, a + 5, y + (WORDS - 6) / 2);
            c.restore();
          }
        });
      });

      // background track
      const by = RULER + WAVE + WORDS + 4;
      const dur = this.cb.getDuration() || 0;
      if (dur > 0) {
        const a = Math.max(0, this.tx(0));
        const b = Math.min(w, this.tx(dur));
        if (b > a) {
          c.fillStyle = C.bgTrack;
          roundRect(c, a, by, b - a, BGT - 4, 4);
          c.fill();
          const label = (this.cb.getBgLabel && this.cb.getBgLabel()) || 'Background';
          c.save();
          c.beginPath(); c.rect(a, by, b - a, BGT - 4); c.clip();
          c.fillStyle = C.wordText;
          c.font = '11.5px "Segoe UI", sans-serif';
          c.fillText(label, Math.max(a, 0) + 10, by + (BGT - 4) / 2);
          c.restore();
        }
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
    c.beginPath();
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  root.SLTimeline = Timeline;
})(self);
