// Lottie export end to end: export through the dialog, play the .json in lottie-web (SVG renderer) in the page,
// and compare it with our evaluator frame by frame (layer centres, opacity, visibility, eased mid-points, text
// bounds, colours), plus the "Left out" list for a mixed scene.
// Usage: node scripts/e2e-lottie.mjs [baseUrl] [outDir]   (the mixed scene uses scripts/fixtures/clip-silent-2s.mp4)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { browserName, launch } from './browser.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = process.argv[3] ?? '.';
const lottieSrc = readFileSync(createRequire(import.meta.url).resolve('lottie-web/build/player/lottie_svg.min.js'), 'utf8');
const browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// Known, unrelated: React's shorthand/longhand warning from the Inspector's fill swatch when a doc is loaded.
page.on('console', (m) => m.type() === 'error' && !/style property during rerender/.test(m.text()) && errors.push(m.text()));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

await page.goto(base);
await page.waitForFunction(() => window.__glyphix && window.__glyphix.saveState() === 'saved');
await page.evaluate(() => window.__glyphix.editor.getState().setPlaying(false));
await page.addScriptTag({ content: lottieSrc });

const dialog = () => page.getByRole('dialog', { name: 'Export' });
async function exportLottie(tag) {
  await page.keyboard.press('Control+e');
  await dialog().waitFor();
  await dialog().getByRole('group', { name: 'Format' }).getByRole('button', { name: 'Lottie', exact: true }).click();
  check(`${tag}: no scale options for Lottie`, (await dialog().getByRole('group', { name: 'Scale' }).count()) === 0);
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), dialog().getByRole('button', { name: /^Export / }).click()]);
  const path = `${out}/${tag}-${download.suggestedFilename()}`;
  await download.saveAs(path);
  await dialog().getByRole('status').waitFor();
  const list = dialog().getByRole('list', { name: /Left out/ });
  const leftOut = (await list.count()) ? await list.getByRole('listitem').allTextContents() : [];
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'hidden' });
  return { name: download.suggestedFilename(), json: JSON.parse(readFileSync(path, 'utf8')), leftOut };
}

/**
 * Load the animation in lottie-web and measure, at each frame: per layer the client rect of its picture / shapes,
 * the opacity product up to the svg, whether it is shown; and our evaluate() at the same time.
 */
const measure = (json, frames) =>
  page.evaluate(
    async ([json, frames]) => {
      const { doc } = window.__glyphix.state();
      const { evaluate } = window.__glyphix.export.lottie;
      const box = document.createElement('div');
      box.style.cssText = `position:fixed;left:0;top:0;width:${json.w}px;height:${json.h}px;z-index:99999;background:#000`;
      document.body.append(box);
      const anim = window.lottie.loadAnimation({ container: box, renderer: 'svg', loop: false, autoplay: false, animationData: json });
      await new Promise((r) => (anim.isLoaded ? r() : anim.addEventListener('DOMLoaded', r)));
      const svg = box.querySelector('svg');
      const shown = (el) => {
        for (let e = el; e && e !== svg; e = e.parentElement) if (getComputedStyle(e).display === 'none') return false;
        return true;
      };
      const opacity = (el) => {
        let o = 1;
        for (let e = el; e && e !== svg; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
        return o;
      };
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, l: r.left, t: r.top, r: r.right, b: r.bottom };
      };
      const els = anim.renderer.elements;
      const rows = [];
      for (const f of frames) {
        anim.goToAndStop(f, true);
        const items = evaluate(doc, f / json.fr).items;
        const layers = json.layers.map((L, i) => {
          const el = els[i].layerElement ?? els[i].baseElement;
          const ours = items.find((it) => it.kind !== 'adjustment' && doc.comp.layers.find((l) => l.id === it.id)?.name === L.nm) ?? null;
          const row = { nm: L.nm, ty: L.ty, shown: shown(el), ours: ours && { x: ours.x, y: ours.y, scale: ours.scale, opacity: ours.opacity, kind: ours.kind } };
          if (L.ty === 2) {
            const img = el.querySelector('image');
            Object.assign(row, rect(img), { opacity: opacity(img) });
          } else {
            const paths = [...el.querySelectorAll('path')].filter((p) => shown(p) && opacity(p) > 0.01 && p.getAttribute('d'));
            row.visiblePaths = paths.length;
            if (paths.length) {
              // Fill geometry only (Firefox counts a stroke's width in client rects, Chrome doesn't).
              const fills = paths.filter((p) => !p.getAttribute('stroke'));
              const rs = (fills.length ? fills : paths).map(rect);
              Object.assign(row, { l: Math.min(...rs.map((r) => r.l)), t: Math.min(...rs.map((r) => r.t)), r: Math.max(...rs.map((r) => r.r)), b: Math.max(...rs.map((r) => r.b)) });
            }
            row.fill = paths.map((p) => p.getAttribute('fill')).find((f) => f && f !== 'none') ?? null;
            if (ours?.kind === 'background') row.ourColor = ours.fill.kind === 'solid' ? ours.fill.color : null;
          }
          return row;
        });
        rows.push({ f, layers });
      }
      anim.destroy();
      box.remove();
      return rows;
    },
    [json, frames],
  );

/** Tight text bounds from our own layout (atlas boxes minus their padding), in comp px, at rest. */
const textBounds = (layerName, t) =>
  page.evaluate(
    ([layerName, t]) => {
      const { doc } = window.__glyphix.state();
      const it = window.__glyphix.export.lottie.evaluate(doc, t).items.find((i) => doc.comp.layers.find((l) => l.id === i.id)?.name === layerName);
      const lay = window.__glyphix.fonts.layout(it);
      const pad = 16 / 64;
      const g = lay.glyphs.filter((x) => x.glyph);
      const k = it.fontSize * it.scale;
      return {
        l: it.x + k * Math.min(...g.map((x) => x.x + x.glyph.l + pad)),
        r: it.x + k * Math.max(...g.map((x) => x.x + x.glyph.r - pad)),
        t: it.y - k * Math.max(...g.map((x) => x.y + x.glyph.t - pad)),
        b: it.y - k * Math.min(...g.map((x) => x.y + x.glyph.b + pad)),
        glyphs: g.length,
      };
    },
    [layerName, t],
  );

/** Every image layer: centre ±1 px and opacity ±0.01 against evaluate(); shown exactly when it is on screen. */
function compareImages(tag, rows) {
  let worst = 0;
  let worstO = 0;
  let visBad = 0;
  for (const { f, layers } of rows) {
    for (const L of layers.filter((l) => l.ty === 2)) {
      // lottie-web also hides a layer while its opacity is 0.
      const visible = L.ours && L.ours.opacity > 1e-3;
      if (L.ours ? visible && !L.shown : L.shown) {
        visBad++;
        console.log(`  ${L.nm} @${f}: lottie ${L.shown ? 'shown' : 'hidden'}, ours ${L.ours ? `on screen (opacity ${L.ours.opacity.toFixed(3)})` : 'off screen'}`);
      }
      if (!L.ours || !L.shown) continue;
      worst = Math.max(worst, Math.hypot(L.x - L.ours.x, L.y - L.ours.y));
      worstO = Math.max(worstO, Math.abs(L.opacity - L.ours.opacity));
      if (Math.hypot(L.x - L.ours.x, L.y - L.ours.y) > 1) console.log(`  ${L.nm} @${f}: lottie ${L.x.toFixed(2)},${L.y.toFixed(2)} ours ${L.ours.x.toFixed(2)},${L.ours.y.toFixed(2)}`);
    }
  }
  check(`${tag}: image centres match evaluate() (±1 px)`, worst <= 1, `worst ${worst.toFixed(3)} px`);
  check(`${tag}: image opacity matches (±0.01)`, worstO <= 0.01, `worst ${worstO.toFixed(4)}`);
  check(`${tag}: layers shown exactly while on screen (in/out points)`, visBad === 0, `${visBad} mismatches`);
}

// ---------------------------------------------------------------------------
// 1. The demo doc
{
  const doc = await page.evaluate(() => window.__glyphix.state().doc);
  const { name, json, leftOut } = await exportLottie('demo');
  const frames = Math.round(doc.comp.duration * doc.comp.fps);
  check('demo: .json download', name.endsWith('.json'), name);
  check('demo: fr / op / size match the comp', json.fr === doc.comp.fps && json.op === frames && json.ip === 0 && json.w === doc.comp.width && json.h === doc.comp.height, `fr ${json.fr} op ${json.op} ${json.w}×${json.h}`);
  check('demo: layers top first', JSON.stringify(json.layers.map((l) => l.nm)) === JSON.stringify(doc.comp.layers.map((l) => l.name).reverse()), json.layers.map((l) => l.nm).join(', '));
  check('demo: "Left out" lists the shadow and glow', leftOut.some((l) => /Screenshot: drop shadow/.test(l)) && leftOut.some((l) => /Headline: glow/.test(l)), leftOut.join(' | '));

  const rows = await measure(json, [0, 3, 7, 12, 15, 22, 30, 45, 75, 120, frames - 1]);
  compareImages('demo', rows);
  // The screenshot's y is a bezier key (ease-out cubic): exact in between frames too.
  const sub = await measure(json, [7.5, 15.5, 22.25]);
  let subWorst = 0;
  for (const { layers } of sub) {
    const L = layers.find((l) => l.nm === 'Screenshot');
    subWorst = Math.max(subWorst, Math.abs(L.y - L.ours.y));
  }
  check('demo: bezier key mid-points exact between frames', subWorst <= 0.05, `worst ${subWorst.toFixed(4)} px`);
  const head0 = rows[0].layers.find((l) => l.nm === 'Headline');
  check('demo: glyph animator starts with every glyph hidden', head0.visiblePaths === 0, `${head0.visiblePaths} visible`);
  const last = rows[rows.length - 1];
  const head = last.layers.find((l) => l.nm === 'Headline');
  const tb = await textBounds('Headline', last.f / json.fr);
  check('demo: every glyph shown at rest', head.visiblePaths === tb.glyphs, `${head.visiblePaths}/${tb.glyphs}`);
  const dt = Math.max(Math.abs(head.l - tb.l), Math.abs(head.r - tb.r), Math.abs(head.t - tb.t), Math.abs(head.b - tb.b));
  check('demo: text glyph bounds match our layout (±3 px)', dt <= 3, `worst edge ${dt.toFixed(2)} px`);
}

// ---------------------------------------------------------------------------
// 2. A mixed scene: animated colour, spring + preset motion, in/out points, gradient + outlined text, counter,
//    effects, tilt and a video layer.
{
  await page.evaluate(async () => {
    const blob = await (await fetch('/scripts/fixtures/clip-silent-2s.mp4')).blob();
    const poster = document.createElement('canvas');
    poster.width = 640;
    poster.height = 360;
    poster.getContext('2d').fillRect(0, 0, 640, 360);
    window.__glyphix.export.putVideoAsset('vid-lottie', poster, blob);
    const doc = structuredClone(window.__glyphix.state().doc);
    doc.name = 'Lottie mixed';
    const [bg, shot, head] = doc.comp.layers;
    bg.fill = { kind: 'solid', color: { track: { keys: [{ t: 0, v: [0.9, 0.1, 0.1, 1], out: { kind: 'linear' } }, { t: 4, v: [0.1, 0.2, 0.9, 1], out: { kind: 'linear' } }] } } };
    const spring = { kind: 'spring', mass: 1, stiffness: 170, damping: 12 };
    const card = {
      ...structuredClone(shot),
      id: 'card',
      name: 'Card',
      width: 600,
      height: 400,
      shadow: null,
      timing: { in: 0.5, out: 4 },
      radius: { track: { keys: [{ t: 0.5, v: 0, out: { kind: 'bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 } }, { t: 2, v: 80, out: { kind: 'linear' } }] } },
      opacity: { static: 1 },
      transform: {
        x: { track: { keys: [{ t: 0.5, v: 400, out: spring }, { t: 2, v: 1400, out: { kind: 'linear' } }] } },
        y: { static: 700 },
        scale: { static: 0.8 },
        rotation: { track: { keys: [{ t: 0, v: 0, out: { kind: 'steps', n: 4 } }, { t: 2, v: 20, out: { kind: 'linear' } }] } },
      },
      motion: { enter: { preset: 'slide-up', start: 0, duration: 0.8, easing: { kind: 'bezier', x1: 0.33, y1: 1, x2: 0.68, y2: 1 } }, exit: { preset: 'fade', endOffset: 0, duration: 0.5, easing: { kind: 'linear' } }, loop: null },
    };
    shot.effects = [{ id: 'fx-blur', kind: 'blur', enabled: true, params: { radius: { static: 6 } }, colors: {}, text: {} }];
    shot.tilt = { rotateX: { static: 12 }, rotateY: { static: 0 }, perspective: 2400 };
    shot.motion = { enter: null, exit: null, loop: { preset: 'float', period: 2, amount: 0.5 } };
    const clip = { ...structuredClone(shot), id: 'clip', name: 'Clip', assetId: 'vid-lottie', effects: [], tilt: { rotateX: { static: 0 }, rotateY: { static: 0 }, perspective: 2400 }, video: { start: 0, in: 0, out: 2, loop: false, volume: 1, muted: true }, width: 320, height: 180, transform: { ...shot.transform, x: { static: 300 }, y: { static: 300 } } };
    head.gradient = { angle: { static: 0 }, from: { static: [1, 0.9, 0.2, 1] }, to: { static: [0.2, 0.9, 1, 1] } };
    head.outline = { width: { static: 4 }, color: { static: [0, 0, 0, 1] } };
    const counter = { ...structuredClone(head), id: 'counter', name: 'Counter', text: { static: 'Frame {frame}' }, animator: null, gradient: null, outline: null, glow: { static: 0 }, transform: { ...head.transform, y: { static: 980 } } };
    doc.comp.layers = [bg, shot, card, clip, head, counter];
    window.__glyphix.editor.getState().loadDoc(doc);
  });
  await page.waitForTimeout(500);
  const doc = await page.evaluate(() => window.__glyphix.state().doc);
  const { json, leftOut } = await exportLottie('mixed');
  const has = (re) => leftOut.some((l) => re.test(l));
  check('mixed: "Left out" names effects, tilt, video and the counter', has(/Screenshot: .*3D tilt.*effects \(Blur\)/) && has(/Video layer 'Clip'/) && has(/Counter: frame counter/) && has(/Headline: glow/), leftOut.join(' | '));
  check('mixed: video layer not in the file', !json.layers.some((l) => l.nm === 'Clip'));
  const cardL = json.layers.find((l) => l.nm === 'Card');
  check('mixed: in/out points → ip/op', cardL.ip === 15 && cardL.op === 120, `ip ${cardL.ip} op ${cardL.op}`);
  check('mixed: comp timing', json.fr === doc.comp.fps && json.op === Math.round(doc.comp.duration * doc.comp.fps));

  const frames = [0, 10, 14, 15, 16, 20, 24, 30, 37, 45, 60, 90, 105, 110, 119, 120, 140, 149];
  const rows = await measure(json, frames);
  compareImages('mixed', rows);
  // Spring (baked per frame) mid-points.
  let spring = 0;
  for (const { f, layers } of rows) {
    const L = layers.find((l) => l.nm === 'Card');
    if (L.ours && f > 15 && f < 60) spring = Math.max(spring, Math.abs(L.x - L.ours.x));
  }
  check('mixed: baked spring within 1 px', spring <= 1, `worst ${spring.toFixed(3)} px`);
  // Background colour (OKLab blend, baked per frame).
  let col = 0;
  for (const { layers } of rows) {
    const L = layers.find((l) => l.nm === 'Background');
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(L.fill ?? '');
    if (!m || !L.ourColor) {
      col = 99;
      continue;
    }
    col = Math.max(col, ...[1, 2, 3].map((i) => Math.abs(Number(m[i]) - L.ourColor[i - 1] * 255)));
  }
  check('mixed: animated background colour matches (±2/255)', col <= 2, `worst ${col.toFixed(2)}`);
  const last = rows[rows.length - 1];
  const head = last.layers.find((l) => l.nm === 'Headline');
  const tb = await textBounds('Headline', last.f / json.fr);
  // Client rects measure the path geometry (the outline stroke isn't included).
  const dt = Math.max(Math.abs(head.l - tb.l), Math.abs(head.r - tb.r), Math.abs(head.t - tb.t), Math.abs(head.b - tb.b));
  check('mixed: outlined gradient text bounds match (±3 px)', dt <= 3, `worst edge ${dt.toFixed(2)} px`);
  check('mixed: gradient text uses a gradient fill', /url\(/.test(head.fill ?? ''), head.fill);
  const counter = last.layers.find((l) => l.nm === 'Counter');
  check('mixed: counter text drawn', counter.visiblePaths > 0, `${counter.visiblePaths} glyph paths`);
}

check(`no page errors (${browserName})`, errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll Lottie checks passed');
process.exit(failures ? 1 : 0);
