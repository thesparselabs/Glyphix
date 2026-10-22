// ASCII text export (Milestone F+3) end to end: the exported text equals what the GPU drew (WebGPU and forced
// WebGL2) and matches the rendered picture, the HTML player plays in time (with and without sound), the React
// output type-checks and runs, and the Export dialog works by keyboard.
// Usage: node scripts/e2e-ascii-text.mjs [baseUrl] [outDir]      (BROWSER=firefox for Firefox)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { unzipSync } from 'fflate';
import { browserName, launch } from './browser.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = process.argv[3] ?? '.';
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
if (browserName === 'chrome') await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => (m.type() === 'error' || /leaked render targets/.test(m.text())) && errors.push(m.text()));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const info = (name, detail) => console.log(`INFO ${name} — ${detail}`);
const ready = () => page.waitForFunction(() => window.__glyphix && window.__glyphix.saveState() === 'saved');

await page.goto(base);
await ready();
await page.keyboard.press('Space'); // pause the preview
await page.evaluate(async () => {
  const s = window.__glyphix.state();
  await window.__glyphix.fonts.loadAll(s.doc.comp.layers.flatMap((l) => (l.type === 'text' ? [l.fontId] : [])));
});

// --- Test documents: the demo with an ASCII adjustment layer (colour / mono), 160 columns across --------
await page.evaluate(async () => {
  const d = await import('/src/doc/index.ts');
  const make = (mono, duration) => {
    const doc = structuredClone(window.__glyphix.state().doc);
    const layer = d.createAdjustmentLayer('ascii');
    const e = layer.effects[0];
    // Square cells: 160 × 90 on a 16:9 comp (font-shaped cells would be half as wide).
    e.params.size = { static: doc.comp.width / 160 };
    e.params.square = { static: 1 };
    e.params.colorMode = { static: mono ? 0 : 1 };
    doc.comp.layers.push(layer);
    doc.comp.duration = duration;
    return { doc, effectId: e.id };
  };
  window.__t = { make, colour: make(false, 10), mono: make(true, 10) };
});
const comp = await page.evaluate(() => window.__t.colour.doc.comp);
info('test doc', `${comp.width}×${comp.height}, ${comp.fps} fps, ${comp.duration}s (cap 10 s), no audio`);

// --- (a) text = what the GPU drew, = the picture, on WebGPU and WebGL2 --------------------------------------
const frameIdx = [0, 7, 31, 100, 217];
for (const forceWebGL of [false, true]) {
  for (const mode of ['colour', 'mono']) {
    const r = await page.evaluate(
      async ({ forceWebGL, mode, frameIdx }) => {
        const { doc, effectId } = window.__t[mode];
        const d = await import('/src/doc/index.ts');
        const { createBackend, renderFrameBitmap } = window.__glyphix.render;
        const at = window.__glyphix.export.asciiText;
        const fps = doc.comp.fps;
        const b = await createBackend({ canvas: document.createElement('canvas'), fullResAssets: true, forceWebGL });
        b.setSize(doc.comp.width, doc.comp.height, 1);
        b.setView(null);
        const res = { backend: b.kind, frames: [] };
        try {
          const times = frameIdx.map((i) => i / fps);
          const { sequence } = await at.captureAsciiSequence(doc, effectId, { times, forceWebGL });
          res.mono = sequence.mono;
          res.grid = `${sequence.cols}×${sequence.rows}`;
          for (let k = 0; k < times.length; k++) {
            const t = times[k];
            const list = d.evaluate(doc, t);
            await b.prepare(list);
            const cells = await b.captureAscii(list, effectId);
            const seq = sequence.frames[k];
            const sameText = seq.lines.length === cells.rows && seq.lines.every((l, y) => l === cells.lines[y]);
            let sameColour = true;
            if (!sequence.mono) {
              for (let y = 0; y < cells.rows && sameColour; y++) {
                for (let x = 0; x < cells.cols; x++) {
                  const o = (y * cells.cols + x) * 4;
                  const hex = [0, 1, 2].map((i) => cells.rgba[o + i].toString(16).padStart(2, '0')).join('');
                  if (seq.colors[y].substr(x * 6, 6) !== hex) { sameColour = false; break; }
                }
              }
            }
            // The picture: mean luminance of each cell's pixels vs. the glyph's typical luminance (per character,
            // normalised by the cell's glyph colour). Same character = same ink coverage, so a wrong readback shows up.
            await renderFrameBitmap(b, doc, t);
            const bmp = await renderFrameBitmap(b, doc, t);
            const c = new OffscreenCanvas(bmp.width, bmp.height);
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(bmp, 0, 0);
            const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
            const lum = (r, gg, bb) => 0.2126 * r + 0.7152 * gg + 0.0722 * bb;
            const bgc = d.sampleValue(doc.comp.layers.at(-1).effects[0].colors.bg, t);
            const bgL = lum(bgc[0] * 255, bgc[1] * 255, bgc[2] * 255);
            const L = [];
            const chars = [];
            for (let y = 0; y < cells.rows; y++) {
              for (let x = 0; x < cells.cols; x++) {
                const x0 = Math.floor(x * cells.cellWidth), x1 = Math.min(bmp.width, Math.ceil((x + 1) * cells.cellWidth));
                const y0 = Math.floor(y * cells.cellHeight), y1 = Math.min(bmp.height, Math.ceil((y + 1) * cells.cellHeight));
                let s = 0, n = 0;
                for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * bmp.width + xx) * 4; s += lum(px[i], px[i + 1], px[i + 2]); n++; }
                const o = (y * cells.cols + x) * 4;
                const inkL = Math.max(lum(cells.rgba[o], cells.rgba[o + 1], cells.rgba[o + 2]), 8);
                L.push((s / n - bgL) / (inkL - bgL > 4 ? inkL - bgL : 4));
                chars.push(cells.lines[y][x]);
              }
            }
            const sum = new Map(), cnt = new Map();
            chars.forEach((ch, i) => { sum.set(ch, (sum.get(ch) ?? 0) + L[i]); cnt.set(ch, (cnt.get(ch) ?? 0) + 1); });
            const E = chars.map((ch) => sum.get(ch) / cnt.get(ch));
            const mean = (a) => a.reduce((p, q) => p + q, 0) / a.length;
            const mL = mean(L), mE = mean(E);
            let sxy = 0, sxx = 0, syy = 0;
            for (let i = 0; i < L.length; i++) { sxy += (L[i] - mL) * (E[i] - mE); sxx += (L[i] - mL) ** 2; syy += (E[i] - mE) ** 2; }
            res.frames.push({ i: frameIdx[k], sameText, sameColour, corr: sxy / Math.sqrt(sxx * syy), distinct: cnt.size });
          }
        } finally {
          await b.idle().catch(() => {});
          b.dispose();
        }
        return res;
      },
      { forceWebGL, mode, frameIdx },
    );
    const tag = `${r.backend} ${mode} ${r.grid}`;
    check(`${tag}: text export = captureAscii (text${mode === 'colour' ? ' + colour' : ''}) on frames ${frameIdx.join(', ')}`, r.frames.every((f) => f.sameText && f.sameColour));
    const worst = Math.min(...r.frames.map((f) => f.corr));
    check(`${tag}: text matches the rendered picture (per-cell ink correlation > 0.99)`, worst > 0.99, `worst ${worst.toFixed(4)}, ${r.frames.map((f) => f.distinct).join('/')} distinct characters`);
    check(`${tag}: colour sequences carry colours, mono ones don't`, r.mono === (mode === 'mono'));
  }
}

// --- Cross-backend: WebGPU text vs WebGL2 text ---------------------------------------------------------
{
  const agree = await page.evaluate(async () => {
    const { doc, effectId } = window.__t.mono;
    const at = window.__glyphix.export.asciiText;
    const a = await at.captureAsciiSequence(doc, effectId, { times: [1.2] });
    const g = await at.captureAsciiSequence(doc, effectId, { times: [1.2], forceWebGL: true });
    let same = 0, total = 0;
    a.sequence.frames[0].lines.forEach((l, y) => [...l].forEach((ch, x) => { total++; if (ch === g.sequence.frames[0].lines[y][x]) same++; }));
    return same / total;
  });
  check('WebGPU and WebGL2 give (almost) the same text', agree > 0.98, `${(agree * 100).toFixed(2)}% of cells equal`);
}

// --- Build outputs in the page -------------------------------------------------------------------------------
const built = await page.evaluate(async () => {
  const at = window.__glyphix.export.asciiText;
  const res = {};
  const b64 = (buf) => {
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const font = await at.loadAsciiFontBytes('');
  for (const mode of ['colour', 'mono']) {
    const { doc, effectId } = window.__t[mode];
    const t0 = performance.now();
    const { sequence } = await at.captureAsciiSequence(doc, effectId);
    const captureMs = performance.now() - t0;
    const o = { captureMs, frames: sequence.frames.length, text: sequence.frames.slice(0, 2).map((f) => f.lines.join('\n')) };
    const enc = new TextEncoder();
    const files = {
      'txt-zip': ['ascii-txt.zip', at.buildTxtZip(sequence)],
      json: ['ascii.json', enc.encode(at.buildJson(sequence))],
      html: ['ascii.html', enc.encode(at.buildHtmlPlayer(sequence, { font, audio: null }, 'ascii test'))],
      react: ['ascii-react.zip', at.buildReactZip(sequence, { font, audio: null })],
    };
    for (const [k, [name, bytes]] of Object.entries(files)) o[k] = { name, size: bytes.length, b64: b64(bytes) };
    o.est = {};
    for (const k of Object.keys(files)) o.est[k] = at.estimateAsciiBytes({ cols: sequence.cols, rows: sequence.rows, frames: sequence.frames.length, color: !sequence.mono, output: k, fontBytes: font.length, audioSeconds: 0 });
    res[mode] = o;
  }
  return res;
});
for (const mode of ['colour', 'mono']) {
  const o = built[mode];
  info(`${mode} sizes (10 s, ${comp.fps} fps, 160 columns)`, `capture ${(o.captureMs / 1000).toFixed(1)}s (${(o.captureMs / o.frames).toFixed(0)} ms/frame); ` + ['txt-zip', 'json', 'html', 'react'].map((k) => `${k} ${(o[k].size / 1e6).toFixed(2)} MB`).join(', '));
  info(`${mode} estimate vs actual`, ['txt-zip', 'json', 'html', 'react'].map((k) => `${k} ${(o.est[k] / 1e6).toFixed(2)} vs ${(o[k].size / 1e6).toFixed(2)} MB`).join(', '));
  for (const k of ['txt-zip', 'json', 'html', 'react']) fs.writeFileSync(`${out}/${mode}-${o[k].name}`, Buffer.from(o[k].b64, 'base64'));
}
{
  const zip = unzipSync(new Uint8Array(Buffer.from(built.colour['txt-zip'].b64, 'base64')));
  const names = Object.keys(zip);
  check('TXT zip: one file per frame, frame-0001.txt first', names.length === comp.duration * comp.fps && names[0] === 'frame-0001.txt' && names.at(-1) === `frame-${String(names.length).padStart(4, '0')}.txt`, `${names.length} files`);
  const first = Buffer.from(zip['frame-0001.txt']).toString();
  check('TXT frame 1 = exported frame 0 text', first === `${built.colour.text[0]}\n`);
  const json = JSON.parse(Buffer.from(built.colour.json.b64, 'base64').toString());
  check('JSON has cols, rows, fps, cellWidth, cellHeight and one entry per frame', json.cols === 160 && json.rows === 90 && json.fps === comp.fps && json.cellWidth > 0 && json.cellHeight > 0 && json.frames.length === names.length, `${json.cols}×${json.rows}`);
  check('JSON colour frames carry colours, mono ones do not', !!json.frames[3].colors && json.frames[3].colors.length === json.rows && json.frames[3].colors[0].length === json.cols * 6 && !JSON.parse(Buffer.from(built.mono.json.b64, 'base64').toString()).frames[3].colors);
}

// --- (b) the HTML player in a fresh page -----------------------------------------------------------------------
async function playerCheck(mode) {
  const file = path.resolve(out, `${mode}-ascii.html`);
  const p = await ctx.newPage();
  const perr = [];
  p.on('pageerror', (e) => perr.push(e.message));
  await p.setViewport?.({ width: 1000, height: 700 });
  await p.setViewportSize({ width: 1000, height: 700 });
  await p.goto(`file://${file}`);
  await p.waitForFunction(() => document.getElementById('app')?.dataset.playing === 'true', null, { timeout: 15000 });
  // Sample the shown frame against the wall clock for 3 s.
  const s = await p.evaluate(async () => {
    const app = document.getElementById('app');
    const samples = [];
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => {
        samples.push([performance.now(), Number(app.dataset.frame), (app.querySelector('pre') ?? { textContent: null }).textContent]);
        if (performance.now() - t0 < 3000) requestAnimationFrame(tick); else res();
      };
      tick();
    });
    return samples;
  });
  const fps = comp.fps;
  // Unwrap loops, then fit frame = (ts - start) * fps: the spread of the residual is the drift.
  const n = comp.duration * fps;
  let wraps = 0;
  const res = s.map(([ts, f], i) => { if (i && f < s[i - 1][1]) wraps++; return (ts - s[0][0]) / 1000 * fps - (f + wraps * n); });
  const spread = Math.max(...res) - Math.min(...res);
  const distinct = new Set(s.map((x) => x[1])).size;
  check(`HTML player (${mode}): frames follow the clock (drift ${spread.toFixed(2)} frames over 3 s)`, spread <= 2.0, `${distinct} distinct frames in 3 s (${(distinct / 3).toFixed(1)}/s of ${fps}), no page errors: ${perr.length === 0}`);
  if (mode === 'mono') {
    // Expected frame at the ~1 s sample: the clock line fitted through all samples (median offset).
    const at1s = s.find((x) => x[0] - s[0][0] >= 1000);
    const f = at1s[1];
    const sorted = [...res].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const expected = Math.round(((at1s[0] - s[0][0]) / 1000) * fps - med) % n;
    const known = built.mono.text;
    // Only frames 0 and 1 are known in node; compare the shown text with the captured one when it is one of them,
    // otherwise check the frame number and that the text has the grid's shape.
    const lines = at1s[2].split('\n');
    check('HTML player (mono): frame shown after ~1 s is the expected one (±1 frame), text has the 160×90 grid', Math.abs(f - expected) <= 1 && lines.length === 90 && lines.every((l) => l.length === 160), `shown ${f}, expected ${expected} (fit of ${s.length} samples)`);
    const p0 = s.find((x) => x[1] === 0 || x[1] === 1);
    if (p0) check('HTML player (mono): frame text equals the exported text', p0[2] === known[p0[1]]);
  } else {
    const canvasOk = await p.evaluate(() => { const c = document.querySelector('canvas'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n > 1000; });
    check('HTML player (colour): canvas shows drawn glyphs', canvasOk);
  }
  // Keyboard: Space pauses, then the frame holds still.
  await p.locator('#app').focus();
  await p.keyboard.press('Space');
  const a = await p.evaluate(() => document.getElementById('app').dataset.frame);
  await p.waitForTimeout(400);
  const b2 = await p.evaluate(() => [document.getElementById('app').dataset.frame, document.getElementById('app').dataset.playing]);
  check(`HTML player (${mode}): Space pauses (frame holds)`, b2[1] === 'false' && b2[0] === a);
  await p.keyboard.press('ArrowRight');
  const c2 = await p.evaluate(() => document.getElementById('app').dataset.frame);
  check(`HTML player (${mode}): ArrowRight steps one frame`, Number(c2) === (Number(a) + 1) % n, `${a} → ${c2}`);
  await p.getByRole('button', { name: 'Play' }).focus();
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.getElementById('app').dataset.playing === 'true');
  check(`HTML player (${mode}): Play button works by keyboard`, true);
  await p.close();
}
await playerCheck('mono');
await playerCheck('colour');
// self-contained: nothing was fetched from the network
const html = fs.readFileSync(`${out}/mono-ascii.html`, 'utf8');
check('HTML player is self-contained (one file, no external URLs)', !/(src|href)=["']https?:/.test(html) && /@font-face/.test(html) && /DecompressionStream/.test(html));

// --- Sound: a synthetic 2.5 s tone drives the player clock -------------------------------------------------------
{
  const html = await page.evaluate(async () => {
    const at = window.__glyphix.export.asciiText;
    const { doc, effectId } = window.__t.mono;
    const short = structuredClone(doc);
    short.comp.duration = 2.5;
    const { sequence } = await at.captureAsciiSequence(short, effectId);
    const buffer = new AudioBuffer({ length: 48000 * 2.5, numberOfChannels: 2, sampleRate: 48000 });
    for (let c = 0; c < 2; c++) { const ch = buffer.getChannelData(c); for (let i = 0; i < ch.length; i++) ch[i] = 0.1 * Math.sin((2 * Math.PI * 440 * i) / 48000); }
    const audio = await at.encodeAudio({ buffer, failed: [] });
    const font = await at.loadAsciiFontBytes('');
    return audio ? { html: at.buildHtmlPlayer(sequence, { font, audio }, 'sound test'), audioBytes: audio.bytes.length, mime: audio.mime } : null;
  });
  check('audio encodes to Opus WebM in this browser', !!html, html ? `${html.audioBytes} bytes for 2.5 s (${(html.audioBytes / 2.5 / 1000).toFixed(1)} kB/s)` : 'no Opus encoder');
  if (html) {
    const file = path.resolve(out, 'ascii-sound.html');
    fs.writeFileSync(file, html.html);
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 800, height: 600 });
    await p.goto(`file://${file}`);
    await p.waitForFunction(() => window.asciiPlayer, null, { timeout: 15000 });
    await p.waitForTimeout(500);
    if ((await p.evaluate(() => document.getElementById('app').dataset.playing)) !== 'true') await p.getByRole('button', { name: 'Play' }).click(); // a click is a user gesture: sound may start
    await p.waitForFunction(() => window.asciiPlayer.audio.currentTime > 0.3, null, { timeout: 10000 }).catch(() => {});
    const st = await p.evaluate(async () => {
      const a = window.asciiPlayer.audio;
      const app = document.getElementById('app');
      await new Promise((r) => setTimeout(r, 300));
      const t = a.currentTime;
      return { t, frame: Number(app.dataset.frame), playing: app.dataset.playing, paused: a.paused, dur: a.duration };
    });
    const fps = comp.fps;
    check('HTML player with sound: audio plays and the frame follows the audio clock (±1 frame)', !st.paused && st.t > 0.5 && Math.abs(st.frame - Math.floor(st.t * fps)) <= 1, `audio ${st.t.toFixed(3)}s, frame ${st.frame} (audio → ${Math.floor(st.t * fps)}), audio length ${st.dur?.toFixed(2)}s`);
    await p.close();
  }
}

// --- (d) the Export dialog by keyboard ------------------------------------------------------------------------------------
await page.evaluate((doc) => window.__glyphix.editor.getState().loadDoc(doc), await page.evaluate(() => window.__t.colour.doc));
await page.evaluate(() => window.__glyphix.setTime(1.5));
const dialog = page.getByRole('dialog', { name: 'Export' });
await page.keyboard.press('Control+e');
await dialog.waitFor();
const asciiBtn = dialog.getByRole('group', { name: 'Format' }).getByRole('button', { name: 'ASCII text', exact: true });
await asciiBtn.focus();
await page.keyboard.press('Enter');
check('dialog: "ASCII text" format exists and is selectable by keyboard', (await asciiBtn.getAttribute('aria-pressed')) === 'true' || (await asciiBtn.getAttribute('aria-checked')) === 'true' || (await asciiBtn.getAttribute('data-state')) === 'on');
check('dialog: labelled controls (effect picker, output group)', (await dialog.getByLabel('ASCII effect').count()) > 0 && (await dialog.getByRole('group', { name: 'Output' }).count()) === 1);
check('dialog: no "Include sound" for a document without audio', (await dialog.getByRole('switch', { name: 'Include sound' }).count()) === 0);
const output = (name) => dialog.getByRole('group', { name: 'Output' }).getByRole('button', { name, exact: true });
await output('JSON').focus();
await page.keyboard.press('Enter');
await dialog.getByText(/about [\d.]+ (KB|MB)/).waitFor({ timeout: 30000 });
const est = await dialog.getByText(/about [\d.]+ (KB|MB)/).textContent();
const exportBtn = dialog.getByRole('button', { name: 'Export ASCII text' });
await exportBtn.focus();
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.keyboard.press('Enter')]);
const dlPath = `${out}/${dl.suggestedFilename()}`;
await dl.saveAs(dlPath);
const dj = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
const actual = fs.statSync(dlPath).size;
const status = await dialog.getByRole('status').textContent();
check('dialog: JSON export downloads (160×90, 300 frames) and reports its size', dj.cols === 160 && dj.frames.length === comp.duration * comp.fps && /Saved .*\.json/.test(status), `${dl.suggestedFilename()}, ${(actual / 1e6).toFixed(2)} MB, ${status.trim()}`);
info('size estimate vs actual (JSON, colour)', `${est.trim()} vs ${(actual / 1e6).toFixed(2)} MB`);
// Copy the current frame by keyboard
await output('Copy frame').focus();
await page.keyboard.press('Enter');
await dialog.getByRole('button', { name: 'Copy ASCII frame' }).focus();
await page.keyboard.press('Enter');
await dialog.getByText(/^Copied the ASCII at/).waitFor({ timeout: 30000 });
if (browserName === 'chrome') {
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const want = await page.evaluate(async () => {
    const { doc, effectId } = window.__t.colour;
    const at = window.__glyphix.export.asciiText;
    // Same renderer as the dialog (it follows the app's ?webgl switch).
    const forceWebGL = window.__glyphix.editor.getState().forceWebGL;
    const t = window.__glyphix.state().time;
    return { same: await at.asciiFrameText(doc, effectId, t, { forceWebGL }), other: await at.asciiFrameText(doc, effectId, t, { forceWebGL: !forceWebGL }) };
  });
  const differ = [...clip].filter((ch, i) => ch !== want.other[i]).length;
  check('dialog: "Copy frame" puts the current frame\'s text on the clipboard', clip.split('\n').length === 90 && clip === want.same, `${clip.length} chars`);
  info('Copy frame: cells that differ between WebGPU and WebGL2 text', `${differ} of ${160 * 90}`);
} else {
  check('dialog: "Copy frame" reports success', true, 'clipboard content not readable in headless Firefox');
}
await page.keyboard.press('Escape');

// --- (c) React output: type-check and run ------------------------------------------------------------------------------
{
  const dir = path.resolve(`.tmp-ascii-react-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const files = unzipSync(new Uint8Array(Buffer.from(built.colour.react.b64, 'base64')));
    check('React zip has AsciiPlayer.tsx, data, engine + types, font', ['AsciiPlayer.tsx', 'ascii-data.ts', 'ascii-player-engine.js', 'ascii-player-engine.d.ts', 'ascii-font.ttf'].every((f) => f in files), Object.keys(files).join(', '));
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
    fs.writeFileSync(path.join(dir, 'entry.tsx'), `import { createRoot } from 'react-dom/client';\nimport AsciiPlayer from './AsciiPlayer';\ncreateRoot(document.getElementById('root')!).render(<AsciiPlayer className="demo" loop />);\n`);
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body style="background:#111"><div id="root" style="width:800px"></div><script type="module" src="./entry.tsx"></script></body></html>');
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2023', 'DOM'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ['*.ts', '*.tsx', '*.d.ts'] }));
    let tscOut = '';
    try { execFileSync('npx', ['tsc', '-p', path.join(dir, 'tsconfig.json')], { stdio: 'pipe' }); } catch (e) { tscOut = String(e.stdout ?? e) ; }
    check('React component type-checks with tsc (strict, jsx react-jsx)', tscOut === '', tscOut.split('\n').slice(0, 4).join(' | '));
    // Run it: Vite (the dev server) transforms the temp folder like any app source.
    const rel = path.relative(process.cwd(), dir);
    const p = await ctx.newPage();
    const perr = [];
    p.on('pageerror', (e) => perr.push(e.message));
    p.on('response', (r) => r.status() >= 400 && !/favicon/.test(r.url()) && perr.push(`${r.status()} ${r.url()}`));
    await p.setViewportSize({ width: 900, height: 700 });
    await p.goto(`${new URL(base).origin}/${rel}/index.html`);
    await p.waitForFunction(() => document.querySelector('.demo')?.dataset.playing === 'true', null, { timeout: 20000 });
    const f1 = await p.evaluate(() => document.querySelector('.demo').dataset.frame);
    await p.waitForTimeout(700);
    const f2 = await p.evaluate(() => document.querySelector('.demo').dataset.frame);
    check('React component renders and plays', f1 !== f2 && perr.length === 0, `frame ${f1} → ${f2}${perr.length ? `, errors: ${perr[0]}` : ''}`);
    await p.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

check('no page errors or console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
await browser.close();
process.exit(failures ? 1 : 0);
