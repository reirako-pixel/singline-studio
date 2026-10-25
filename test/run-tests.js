// Node tests for the lyric layout and ASS karaoke generator.
//   npm test                 -> logic checks
//   node test/run-tests.js --render out.mp4   -> also renders a short clip with ffmpeg
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('../src/lib/lyrics.js');
const Lay = require('../src/lib/layout.js');
const Ass = require('../src/lib/ass.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok  ', name); } catch (e) { console.error('FAIL', name, '\n    ', e.message); process.exitCode = 1; }
}

// Rough measurement stand-in: 0.55 em per character.
const measure = (text, px) => [...text].length * px * 0.55;

const lyrics = [
  'Every streetlight wrote our names in gold',
  'and the night kept singing back',
  'every word we never said',
  'so we drove until the dawn',
];
function timed() {
  let t = 5.0;
  return lyrics.map((line, i) => {
    if (i === 2) t += 6; // instrumental break -> new verse with countdown
    const words = L.tokenize(line).map((text) => { const w = { text, start: t, end: t + 0.38 }; t += 0.45; return w; });
    t += 0.6;
    return { singer: i === 3 ? 2 : 1, words };
  });
}

test('tokenize matches worker rules', () => {
  assert.deepStrictEqual(L.tokenize('Hello, world! 你好世界。 こんにちは'),
    ['Hello,', 'world!', '你', '好', '世', '界。', 'こ', 'ん', 'に', 'ち', 'は']);
  assert.deepStrictEqual(L.tokenize('  Mahal  kita  '), ['Mahal', 'kita']);
});

test('joinWords adds spaces only between spaced words', () => {
  const j = L.joinWords([{ text: '你' }, { text: '好' }, { text: 'world' }]);
  assert.strictEqual(j.text, '你好 world');
  assert.deepStrictEqual(j.prefixes, ['', '你', '你好 ']);
});

test('retimeLine keeps the line span', () => {
  const line = { singer: 1, words: [{ text: 'a', start: 1, end: 1.5 }, { text: 'b', start: 1.5, end: 2 }] };
  const r = L.retimeLine(line, 'one two three');
  assert.strictEqual(r.words.length, 3);
  assert.strictEqual(r.words[0].start, 1);
  assert.ok(Math.abs(r.words[2].end - 2) < 0.01);
});

test('karaoke layout: rows alternate and never overlap in the same row', () => {
  const scene = Lay.buildScene({ title: 'Midnight Drive', artist: 'Test', lines: timed(), style: { layout: 'karaoke' } }, measure);
  const lines = scene.items.filter((i) => i.kind === 'line');
  assert.strictEqual(lines.length, 4);
  for (let i = 2; i < lines.length; i++) assert.ok(lines[i].appear >= lines[i - 2].hide - 1e-9, 'row overlap at ' + i);
  for (const l of lines) assert.ok(l.appear < l.words[0].start, 'line shows before it is sung');
  assert.notStrictEqual(lines[0].y, lines[1].y);
  assert.strictEqual(lines[0].y, lines[2].y);
});

test('countdown before the first verse and after the break', () => {
  const scene = Lay.buildScene({ lines: timed(), style: {} }, measure);
  const cd = scene.items.filter((i) => i.kind === 'countdown').map((i) => i.index);
  assert.deepStrictEqual(cd, [0, 2]);
});

test('title card only fits in a long enough intro', () => {
  const s1 = Lay.buildScene({ title: 'X', lines: timed(), style: {} }, measure);
  assert.ok(s1.items.some((i) => i.kind === 'title'));
  const short = timed().map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, start: w.start - 4, end: w.end - 4 })) }));
  const s2 = Lay.buildScene({ title: 'X', lines: short, style: {} }, measure);
  assert.ok(!s2.items.some((i) => i.kind === 'title'));
});

test('long lines are scaled down to fit', () => {
  const long = [{ singer: 1, words: L.tokenize('word '.repeat(40)).map((t, i) => ({ text: t, start: 1 + i * 0.2, end: 1.15 + i * 0.2 })) }];
  const it = Lay.buildScene({ lines: long, style: {} }, measure).items.find((i) => i.kind === 'line');
  assert.ok(it.scale < 1);
  assert.ok(it.width <= 1920 * 0.881);
});

test('single layout: one line at a time', () => {
  const scene = Lay.buildScene({ lines: timed(), style: { layout: 'single' } }, measure);
  const lines = scene.items.filter((i) => i.kind === 'line');
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].appear >= lines[i - 1].hide - 1e-9);
});

test('duet layout aligns singers left and right', () => {
  const scene = Lay.buildScene({ lines: timed(), style: { layout: 'duet' } }, measure);
  const lines = scene.items.filter((i) => i.kind === 'line');
  assert.strictEqual(lines[0].align, 'left');
  assert.strictEqual(lines[3].align, 'right');
  assert.strictEqual(lines[3].fill, Lay.DEFAULT_STYLE.wipeColor2);
});

test('sungWidth moves left to right through a word', () => {
  const it = Lay.buildScene({ lines: timed(), style: {} }, measure).items.find((i) => i.kind === 'line');
  const w = it.words[1];
  assert.strictEqual(Lay.sungWidth(it, w.start - 0.01), it.words[0].x1);
  const mid = Lay.sungWidth(it, (w.start + w.end) / 2);
  assert.ok(mid > w.x0 && mid < w.x1);
});

test('ASS colours and timestamps', () => {
  assert.strictEqual(Ass.col('#FFC24B'), '&H004BC2FF');
  assert.strictEqual(Ass.ts(3725.456), '1:02:05.46');
});

test('ASS karaoke timing adds up to each word end', () => {
  const scene = Lay.buildScene({ lines: timed(), style: { font: { family: 'DejaVu Sans', path: 'x', metrics: { a: 0.93, d: 0.24 } } } }, measure);
  const ass = Ass.buildAss(scene, { title: 'Test' });
  const first = ass.split('\n').find((l) => l.startsWith('Dialogue: 1,'));
  const it = scene.items.find((i) => i.kind === 'line');
  const ks = [...first.matchAll(/\\kf?(\d+)/g)].map((m) => Number(m[1]));
  const total = ks.reduce((a, b) => a + b, 0) / 100;
  assert.ok(Math.abs(it.appear + total - it.words[it.words.length - 1].end) < 0.011, 'karaoke total mismatch');
  assert.ok(/Style: Lyric,DejaVu Sans,91\.3,/.test(ass), 'font size uses ascent+descent ratio');
  assert.ok(ass.includes('\\p1}m 0'), 'countdown dots drawn');
});

test('ASS escapes braces and backslashes in lyrics', () => {
  const lines = [{ singer: 1, words: [{ text: '{oops}', start: 4, end: 4.5 }, { text: 'a\\Nb', start: 4.5, end: 5 }] }];
  const ass = Ass.buildAss(Lay.buildScene({ lines, style: {} }, measure));
  const ev = ass.split('\n').find((l) => l.startsWith('Dialogue: 1,'));
  assert.ok(ev.includes('(oops)') && ev.includes('a/Nb'));
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);

// Optional: render a short clip to eyeball the karaoke output.
const ri = process.argv.indexOf('--render');
if (ri > 0) {
  const out = path.resolve(process.argv[ri + 1] || 'test-render.mp4');
  const fontPath = process.argv[ri + 2];
  const metrics = { a: Number(process.argv[ri + 3]) || 0.93, d: Number(process.argv[ri + 4]) || 0.24 };
  const family = process.argv[ri + 5] || 'DejaVu Sans';
  const scene = Lay.buildScene({ title: 'Midnight Drive', artist: 'SingLine Test', lines: timed(),
    style: { font: { family, path: fontPath, metrics } } }, measure);
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'slr-'));
  fs.mkdirSync(path.join(dir, 'fonts'));
  if (fontPath) fs.copyFileSync(fontPath, path.join(dir, 'fonts', path.basename(fontPath)));
  fs.writeFileSync(path.join(dir, 'lyrics.ass'), Ass.buildAss(scene, { title: 'test' }));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x1E2240:s=1920x1080:r=30',
    '-f', 'lavfi', '-i', 'sine=f=330', '-filter_complex', '[0:v]subtitles=lyrics.ass:fontsdir=fonts[v]',
    '-map', '[v]', '-map', '1:a', '-t', '22', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', out], { cwd: dir, stdio: 'inherit' });
  console.log('rendered', out);
}
