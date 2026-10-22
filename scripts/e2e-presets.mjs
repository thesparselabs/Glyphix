// Milestone K end to end (animation presets): save a keyed + motion animation from the UI, apply it to a layer that
// sits elsewhere (positions shift by the offset, scale by the factor), one undo step, the library survives a reload,
// export .json -> delete -> import applies identically, bad files give readable errors, copy / paste animation.
// Usage: node scripts/e2e-presets.mjs [baseUrl] [outDir]
import { writeFileSync, readFileSync } from 'node:fs';
import { launch } from './browser.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = process.argv[3] ?? '.';
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const layer = (id) => page.evaluate((id) => window.__glyphix.state().doc.comp.layers.find((l) => l.id === id) ?? null, id);
const items = (ids, times) =>
  page.evaluate(
    async ([ids, times]) => {
      const { evaluate } = await import('/src/doc/evaluate.ts');
      const doc = window.__glyphix.state().doc;
      return times.map((t) => Object.fromEntries(evaluate(doc, t).items.filter((i) => ids.includes(i.id)).map((i) => [i.id, { x: i.x, y: i.y, scale: i.scale, opacity: i.opacity }])));
    },
    [ids, times],
  );
const boot = async () => {
  await page.waitForFunction(() => window.__glyphix && window.__glyphix.saveState() === 'saved', null, { timeout: 30000 });
  await page.evaluate(() => window.__glyphix.editor.getState().setPlaying(false));
};
const savedTab = async () => {
  await page.getByRole('tab', { name: 'Saved' }).click();
  await page.waitForTimeout(250);
};
const select = async (id) => {
  await page.evaluate((id) => window.__glyphix.select(id), id);
  await page.waitForTimeout(250);
};
const focusBody = () => page.locator('body').click({ position: { x: 5, y: 5 } });
const TIMES = [0.2, 0.5, 1, 1.5, 2.5, 4];
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

await page.goto(base);
await boot();

// --- Source: the demo photo with an x animation and an enter preset on top of its own keys.
await page.evaluate(() => {
  const s = window.__glyphix.editor.getState();
  const i = s.doc.comp.layers.findIndex((l) => l.id === 'shot');
  const k = (t, v) => ({ t, v, out: { kind: 'linear' } });
  s.set('setup', [
    { path: ['comp', 'layers', i, 'transform', 'x'], value: { track: { keys: [k(0, 300), k(1, 900)] } } },
    { path: ['comp', 'layers', i, 'motion', 'enter'], value: { preset: 'pop', start: 0.1, duration: 0.8, easing: { kind: 'linear' } } },
  ]);
});
await select('shot');
await savedTab();
check('Saved tab starts empty', (await page.getByText('No saved animations yet.').count()) === 1);
await page.getByLabel('Preset name').fill('Slide pop');
await page.getByRole('button', { name: /^Save/ }).click();
await page.getByRole('button', { name: 'Apply Slide pop' }).waitFor({ timeout: 5000 });
check('save from the UI lists the preset', true);
const stored = await page.evaluate(() => window.__glyphix.presets.listPresets());
check('stored with relative x and a motion', stored.length === 1 && stored[0].tracks.some((t) => t.propId === 'x' && t.rel === 'add' && t.keys[1].v === 600) && stored[0].motion?.enter?.preset === 'pop', JSON.stringify(stored[0]?.tracks.map((t) => [t.propId, t.rel])));

// --- Target: another image placed elsewhere, half the size, nothing animated.
const otherId = await page.evaluate(() => {
  const g = window.__glyphix.editor.getState();
  g.duplicateLayer('shot');
  const s = window.__glyphix.editor.getState();
  const id = s.selectedId;
  const i = s.doc.comp.layers.findIndex((l) => l.id === id);
  const p = (path, value) => ({ path: ['comp', 'layers', i, ...path], value });
  s.set('setup other', [
    p(['transform'], { x: { static: 1400 }, y: { static: 200 }, scale: { static: 0.5 }, rotation: { static: 0 } }),
    p(['opacity'], { static: 1 }),
    p(['motion'], { enter: null, exit: null, loop: null }),
  ]);
  return id;
});
await select(otherId);
await savedTab();
const before = await layer(otherId);
await page.getByRole('button', { name: 'Apply Slide pop' }).click();
await page.waitForTimeout(300);
const status = await page.getByRole('status').allTextContents();
check('toast says what was applied', status.some((t) => t.includes("Applied 'Slide pop'")), status.join(' | '));
const after = await layer(otherId);
const rows = await items(['shot', otherId], TIMES);
const [dx, dy, f] = [1400 - 300, 200 - 700, 0.5 / 0.94];
check(
  'position follows the source shifted by the offset, scale by the factor',
  rows.every((r) => near(r[otherId].x, r.shot.x + dx, 0.05) && near(r[otherId].y, r.shot.y + dy, 0.05) && near(r[otherId].scale, r.shot.scale * f, 0.005) && near(r[otherId].opacity, r.shot.opacity, 0.01)),
  JSON.stringify(rows.slice(0, 3)),
);
check('motion copied too', after.motion.enter?.preset === 'pop');
await page.evaluate(() => window.__glyphix.editor.getState().undo());
const undone = await layer(otherId);
check('one undo step reverts the whole apply', JSON.stringify(undone) === JSON.stringify(before));
await page.evaluate(() => window.__glyphix.editor.getState().redo());
const appliedJson = JSON.stringify(pick(await layer(otherId)));
function pick(l) {
  return { transform: l.transform, opacity: l.opacity, motion: l.motion };
}

// --- Reload: the library is still there (and so is the autosaved target layer).
// Autosave is debounced: let it start, then wait until it has written (as e2e-persistence does).
await page.waitForTimeout(1200);
await page.waitForFunction(() => window.__glyphix.saveState() === 'saved', null, { timeout: 30000 });
await page.reload();
await boot();
await select('shot');
await savedTab();
check('library survives a reload', (await page.getByRole('button', { name: 'Apply Slide pop' }).count()) === 1);

// --- Export .json -> delete -> import -> applies identically.
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export…', exact: true }).click()]);
const file = `${out}/glyphix-presets.json`;
await download.saveAs(file);
const json = JSON.parse(readFileSync(file, 'utf8'));
check('export is a glyphix-presets file', json.format === 'glyphix-presets' && json.version === 1 && json.presets.length === 1 && download.suggestedFilename().endsWith('.json'));
await page.getByRole('button', { name: 'Delete Slide pop' }).click();
await page.getByText('No saved animations yet.').waitFor();
check('delete removes it', (await page.evaluate(() => window.__glyphix.presets.listPresets())).length === 0);
await page.getByLabel('Import animations file').setInputFiles(file);
await page.getByRole('button', { name: 'Apply Slide pop' }).waitFor({ timeout: 5000 });
check('import brings it back', true);
// Reset the target (it keeps the earlier apply after the reload) and apply the imported preset.
check('target layer was restored from autosave', !!(await layer(otherId)));
await page.evaluate((id) => {
  const s = window.__glyphix.editor.getState();
  const i = s.doc.comp.layers.findIndex((l) => l.id === id);
  const p = (path, value) => ({ path: ['comp', 'layers', i, ...path], value });
  s.set('reset other', [p(['transform'], { x: { static: 1400 }, y: { static: 200 }, scale: { static: 0.5 }, rotation: { static: 0 } }), p(['opacity'], { static: 1 }), p(['motion'], { enter: null, exit: null, loop: null })]);
}, otherId);
await select(otherId);
await savedTab();
await page.getByRole('button', { name: 'Apply Slide pop' }).click();
await page.waitForTimeout(300);
check('imported preset applies identically', JSON.stringify(pick(await layer(otherId))) === appliedJson);
// Importing the same file again keeps both (new id on clash).
await page.getByLabel('Import animations file').setInputFiles(file);
// (A promise is truthy, so waitForFunction would not wait for the list: poll it here.)
for (let i = 0; i < 50 && (await page.evaluate(() => window.__glyphix.presets.listPresets().then((l) => l.length))) !== 2; i++) await page.waitForTimeout(100);
const ids = (await page.evaluate(() => window.__glyphix.presets.listPresets())).map((p) => p.id);
check('importing again gives the copy a new id', ids.length === 2 && ids[0] !== ids[1]);

// --- Bad files give readable errors.
const bad = async (name, content, expected) => {
  const p = `${out}/${name}`;
  writeFileSync(p, content);
  await page.getByLabel('Import animations file').setInputFiles(p);
  await page.getByRole('alert').filter({ hasText: expected }).first().waitFor({ timeout: 4000 }).then(
    () => check(`bad file: ${name}`, true),
    async () => check(`bad file: ${name}`, false, (await page.getByRole('alert').allTextContents()).join(' | ')),
  );
};
await bad('bad-format.json', '{"hello": 1}', 'not a Glyphix presets file');
await bad('bad-text.json', 'nope {', 'not valid JSON');
await bad('bad-newer.json', JSON.stringify({ format: 'glyphix-presets', version: 9, presets: [] }), 'newer version');
const damaged = JSON.parse(JSON.stringify(json));
damaged.presets.push({ ...damaged.presets[0], id: 'x', tracks: [{ ...damaged.presets[0].tracks[0], keys: [{ dt: 0, v: 'oops', out: { kind: 'linear' } }] }] });
await bad('bad-entry.json', JSON.stringify(damaged), 'Preset 2 is damaged');
check('a bad file changed nothing', (await page.evaluate(() => window.__glyphix.presets.listPresets())).length === 2);

// --- Copy / paste animation between layers (shortcuts and buttons).
const resetOther = () =>
  page.evaluate((id) => {
    const s = window.__glyphix.editor.getState();
    const i = s.doc.comp.layers.findIndex((l) => l.id === id);
    const p = (path, value) => ({ path: ['comp', 'layers', i, ...path], value });
    s.set('reset other', [p(['transform'], { x: { static: 1000 }, y: { static: 300 }, scale: { static: 1 }, rotation: { static: 0 } }), p(['opacity'], { static: 1 }), p(['motion'], { enter: null, exit: null, loop: null })]);
  }, otherId);
await resetOther();
await select('shot');
await focusBody();
await page.keyboard.press('Control+Alt+c');
await page.getByRole('status').filter({ hasText: 'Animation copied' }).waitFor({ timeout: 3000 });
check('Ctrl+Alt+C copies the animation', true);
await select(otherId);
await focusBody();
await page.keyboard.press('Control+Alt+v');
await page.waitForTimeout(300);
let o = await layer(otherId);
check('Ctrl+Alt+V pastes it onto another layer', 'track' in o.transform.x && o.transform.x.track.keys[0].v === 1000 && o.motion.enter?.preset === 'pop', JSON.stringify(o.transform.x));
await page.evaluate(() => window.__glyphix.editor.getState().undo());
o = await layer(otherId);
check('paste is one undo step', 'static' in o.transform.x && o.motion.enter === null);
await page.getByRole('button', { name: 'Paste animation' }).click();
await page.waitForTimeout(300);
o = await layer(otherId);
check('the Paste animation button works', 'track' in o.transform.x);
await select('shot');
await page.getByRole('button', { name: 'Copy animation' }).click();
check('the Copy animation button works', (await page.getByRole('status').filter({ hasText: 'Animation copied' }).count()) === 1);
// An adjustment layer cannot take an image animation: readable message, nothing changes.
await page.evaluate(() => window.__glyphix.editor.getState().addAdjustment());
await page.waitForTimeout(250);
await focusBody();
await page.keyboard.press('Control+Alt+v');
await page.getByRole('alert').filter({ hasText: 'Made for an image or text layer' }).first().waitFor({ timeout: 3000 }).then(
  () => check('pasting onto the wrong layer type explains why', true),
  async () => check('pasting onto the wrong layer type explains why', false, (await page.getByRole('alert').allTextContents()).join(' | ') + ' / ' + (await page.getByRole('status').allTextContents()).join(' | ') + ' sel=' + (await page.evaluate(() => window.__glyphix.state().selectedId))),
);
await page.screenshot({ path: `${out}/presets.png` });

console.log(errors.length ? `page errors:\n${errors.slice(0, 10).join('\n')}` : 'no page errors');
if (errors.length) failures++;
await browser.close();
process.exit(failures ? 1 : 0);
