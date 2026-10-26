// Canvas renderer for the live preview. Draws the same scene the ASS export
// uses, with matching font metrics, outline, shadow and wipe.
(function (root) {
  const { alphaAt, motionAt, wordProgress } = root.SLLayout;

  function fontCss(style, px, cssFamily, boldOverride) {
    const bold = boldOverride === undefined ? style.bold : boldOverride;
    return `${bold ? 700 : 400} ${px}px "${cssFamily}", "Segoe UI", Arial, sans-serif`;
  }

  // Width measurement bound to a font family alias (used by buildScene).
  function makeMeasure(cssFamilyRef) {
    const c = document.createElement('canvas').getContext('2d');
    const cache = new Map();
    return function measure(text, px, bold) {
      const key = cssFamilyRef() + '|' + px + '|' + (bold ? 1 : 0) + '|' + text;
      let v = cache.get(key);
      if (v === undefined) {
        c.font = `${bold ? 700 : 400} ${px}px "${cssFamilyRef()}", "Segoe UI", Arial, sans-serif`;
        v = c.measureText(text).width;
        if (cache.size > 20000) cache.clear();
        cache.set(key, v);
      }
      return v;
    };
  }

  function cover(ctx, media, mw, mh, W, H) {
    if (!mw || !mh) return;
    const s = Math.max(W / mw, H / mh);
    const dw = mw * s;
    const dh = mh * s;
    ctx.drawImage(media, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  function drawBackground(ctx, style, media, W, H) {
    const bg = style.bg;
    ctx.fillStyle = bg.color || '#000';
    ctx.fillRect(0, 0, W, H);
    if (bg.type === 'image' && media.image && media.image.complete) {
      cover(ctx, media.image, media.image.naturalWidth, media.image.naturalHeight, W, H);
    } else if (bg.type === 'video' && media.video && media.video.readyState >= 2) {
      cover(ctx, media.video, media.video.videoWidth, media.video.videoHeight, W, H);
    }
    if (bg.type !== 'color' && bg.dim > 0) {
      ctx.fillStyle = `rgba(0,0,0,${bg.dim})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // Baseline that puts the text box (ascent+descent, as libass sees it)
  // centred on y, which is what \an5 does.
  function baseline(style, y, px) {
    const m = (style.font && style.font.metrics) || { a: 0.95, d: 0.25 };
    return y + ((m.a - m.d) / 2) * px;
  }

  function drawTextLayers(ctx, text, style, opts) {
    const { shadow, outline, fill } = opts;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    if (shadow) {
      const off = Math.max(2, Math.round(style.fontSize * 0.045));
      ctx.save();
      ctx.translate(off / opts.scale, off / opts.scale);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      if (style.outlineWidth > 0) {
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = (style.outlineWidth * 2) / opts.scale;
        ctx.strokeText(text, 0, 0);
      }
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
    if (outline && style.outlineWidth > 0) {
      ctx.strokeStyle = style.outlineColor;
      ctx.lineWidth = (style.outlineWidth * 2) / opts.scale;
      ctx.strokeText(text, 0, 0);
    }
    ctx.fillStyle = fill;
    ctx.fillText(text, 0, 0);
  }

  // Offscreen buffer for lines drawn with partial opacity: the line is drawn
  // fully opaque, then composited once, so overlapping layers don't show
  // through each other (that is how libass renders a translucent line).
  let buf = null;
  function getBuffer(w, h) {
    if (!buf) buf = document.createElement('canvas');
    if (buf.width !== w || buf.height !== h) { buf.width = w; buf.height = h; }
    return buf.getContext('2d');
  }

  const GLOW_OP = 0.85;

  function drawLine(ctx, it, style, t, cssFamily) {
    const a = alphaAt(it, t);
    if (a <= 0.003) return;
    if (a < 0.999) {
      const b = getBuffer(ctx.canvas.width, ctx.canvas.height);
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.clearRect(0, 0, b.canvas.width, b.canvas.height);
      b.setTransform(ctx.getTransform());
      paintLine(b, it, style, t, cssFamily);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = a;
      ctx.drawImage(b.canvas, 0, 0);
      ctx.restore();
    } else {
      paintLine(ctx, it, style, t, cssFamily);
    }
  }

  function paintLine(ctx, it, style, t, cssFamily) {
    const mo = motionAt(it, t);
    const scale = it.scale * mo.s;
    const width = (it.width / it.scale) * scale;
    const left = it.cx - width / 2;
    const by = baseline(style, mo.y, it.fontPx * scale);
    const mode = style.highlight || 'wipe';
    const k = scale / it.scale;  // word x positions are stored at it.scale
    ctx.save();
    ctx.translate(left, by);
    ctx.font = fontCss(style, it.fontPx, cssFamily);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    // sung regions: [x0, x1, amount] in line pixels
    const regions = [];
    if (mode === 'fade') {
      for (const w of it.words) {
        const p = wordProgress(style, w, t);
        if (p > 0) regions.push([w.x0 * k, w.x1 * k, p]);
      }
    } else {
      let sw = 0;
      for (const w of it.words) {
        const p = wordProgress(style, w, t);
        if (p <= 0) break;
        sw = p >= 1 ? w.x1 : w.x0 + (w.x1 - w.x0) * p;
        if (p < 1) break;
      }
      if (sw > 0) regions.push([-4, sw * k + (sw >= it.words[it.words.length - 1].x1 ? 4 : 0), 1]);
    }
    const clipTo = (c, x0, x1) => { c.beginPath(); c.rect(x0, -it.fontPx * 2, x1 - x0, it.fontPx * 4); c.clip(); };

    // neon glow: a thickened, blurred copy of each sung word underneath
    if (style.glow) {
      const lit = it.words.map((w) => {
        if (mode !== 'word') return wordProgress(style, w, t);
        return t < w.start ? 0 : Math.min(1, (t - w.start) / 0.06);
      });
      if (lit.some((v) => v > 0)) {
        const dev = Math.abs(ctx.getTransform().a);  // device px per frame px
        const blur = Math.max(5, style.fontSize * 0.12);
        const bord = Math.max(2, style.fontSize * 0.05);
        const g = getGlowBuffer(ctx.canvas.width, ctx.canvas.height);
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, g.canvas.width, g.canvas.height);
        g.setTransform(ctx.getTransform());
        g.scale(scale, scale);
        g.font = ctx.font;
        g.textBaseline = 'alphabetic';
        g.lineJoin = 'round';
        g.fillStyle = it.fill;
        g.strokeStyle = it.fill;
        g.lineWidth = (bord * 2) / scale;
        it.words.forEach((w, i) => {
          if (lit[i] <= 0) return;
          g.globalAlpha = lit[i];
          const x = (w.x0 / it.scale);
          g.strokeText(w.text, x, 0);
          g.fillText(w.text, x, 0);
        });
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha *= GLOW_OP;
        ctx.filter = `blur(${(blur * dev).toFixed(2)}px)`;
        ctx.drawImage(g.canvas, 0, 0);
        ctx.restore();
      }
    }

    // unsung text with outline and shadow
    ctx.save();
    ctx.scale(scale, scale);
    drawTextLayers(ctx, it.text, style, { shadow: style.shadow, outline: true, fill: style.textColor, scale });
    ctx.restore();

    // sung fill on top
    for (const [x0, x1, amt] of regions) {
      ctx.save();
      clipTo(ctx, x0, x1);
      ctx.scale(scale, scale);
      ctx.globalAlpha *= amt;
      ctx.fillStyle = it.fill;
      ctx.fillText(it.text, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  let gbuf = null;
  function getGlowBuffer(w, h) {
    if (!gbuf) gbuf = document.createElement('canvas');
    if (gbuf.width !== w || gbuf.height !== h) { gbuf.width = w; gbuf.height = h; }
    return gbuf.getContext('2d');
  }

  function drawCountdown(ctx, it, t) {
    if (t < it.appear || t >= it.start) return;
    const spacing = it.r * 3.2;
    ctx.save();
    for (let k = 0; k < 3; k++) {
      if (t >= it.start - (2 - k)) continue;
      ctx.beginPath();
      ctx.arc(it.cx + (k - 1) * spacing, it.y, it.r, 0, Math.PI * 2);
      ctx.fillStyle = it.fill;
      ctx.fill();
    }
    ctx.restore();
  }

  function drawTitle(ctx, it, style, t, cssFamily) {
    if (t < it.appear || t > it.hide) return;
    const a = Math.min(1, (t - it.appear) / 0.4, (it.hide - t) / 0.4);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const put = (text, y, px, bold) => {
      ctx.save();
      ctx.font = fontCss(style, px, cssFamily, bold);
      ctx.translate(it.cx, baseline(style, y, px));
      drawTextLayers(ctx, text, style, { shadow: style.shadow, outline: true, fill: style.textColor, scale: 1 });
      ctx.restore();
    };
    if (it.title) put(it.title, it.y, it.fontPx, style.bold);
    if (it.artist) put(it.artist, it.y + it.fontPx * 0.95, Math.round(it.fontPx * 0.55), false);
    ctx.restore();
  }

  // Draw one frame. ctx is a 2D context of any size; it is scaled to 1920x1080.
  function drawFrame(ctx, scene, t, media, cssFamily) {
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    const { W, H } = scene;
    ctx.setTransform(cw / W, 0, 0, ch / H, 0, 0);
    drawBackground(ctx, scene.style, media || {}, W, H);
    for (const it of scene.items) {
      if (it.kind === 'title') drawTitle(ctx, it, scene.style, t, cssFamily);
      else if (it.kind === 'countdown') drawCountdown(ctx, it, t);
    }
    for (const it of scene.items) {
      if (it.kind === 'line' && t >= it.appear && t <= it.hide) drawLine(ctx, it, scene.style, t, cssFamily);
    }
  }

  root.SLRender = { drawFrame, makeMeasure, fontCss };
})(self);
