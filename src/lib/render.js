// Canvas renderer for the live preview. Draws the same scene the ASS export
// uses, with matching font metrics, outline, shadow and wipe.
(function (root) {
  const { W, H, alphaAt, sungWidth } = root.SLLayout;

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

  function cover(ctx, media, mw, mh) {
    if (!mw || !mh) return;
    const s = Math.max(W / mw, H / mh);
    const dw = mw * s;
    const dh = mh * s;
    ctx.drawImage(media, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  function drawBackground(ctx, style, media) {
    const bg = style.bg;
    ctx.fillStyle = bg.color || '#000';
    ctx.fillRect(0, 0, W, H);
    if (bg.type === 'image' && media.image && media.image.complete) {
      cover(ctx, media.image, media.image.naturalWidth, media.image.naturalHeight);
    } else if (bg.type === 'video' && media.video && media.video.readyState >= 2) {
      cover(ctx, media.video, media.video.videoWidth, media.video.videoHeight);
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

  function drawLine(ctx, it, style, t, cssFamily) {
    const a = alphaAt(it, t);
    if (a <= 0) return;
    const by = baseline(style, it.y, it.fontPx * it.scale);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(it.left, by);
    ctx.font = fontCss(style, it.fontPx, cssFamily);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    // unsung text with outline and shadow
    ctx.save();
    ctx.scale(it.scale, it.scale);
    drawTextLayers(ctx, it.text, style, { shadow: style.shadow, outline: true, fill: style.textColor, scale: it.scale });
    ctx.restore();
    // sung part, clipped to the wipe position
    const sw = sungWidth(it, t);
    if (sw > 0) {
      ctx.beginPath();
      ctx.rect(-4, -it.fontPx * 2, sw + 4, it.fontPx * 4);
      ctx.clip();
      ctx.scale(it.scale, it.scale);
      ctx.fillStyle = it.fill;
      ctx.fillText(it.text, 0, 0);
    }
    ctx.restore();
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
    ctx.setTransform(cw / W, 0, 0, ch / H, 0, 0);
    drawBackground(ctx, scene.style, media || {});
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
