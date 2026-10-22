// Persistence: autosave → reload restores the same doc + images; old projects migrate;
// missing images warn instead of failing. Usage: node scripts/e2e-persistence.mjs [baseUrl]
import { launch } from './browser.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); // fresh context = empty IndexedDB
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const ready = async () => {
  await page.waitForFunction(() => window.__glyphix && document.querySelector('[aria-label="Project name"]'));
};
const saved = () => page.waitForFunction(() => window.__glyphix.saveState() === 'saved', null, { timeout: 15000 });
const docJson = () => page.evaluate(() => JSON.stringify(window.__glyphix.state().doc));

await page.goto(base);
await ready();
await saved();
const firstId = await page.evaluate(() => window.__glyphix.state().doc.id);
check('first run creates and saves a new project', firstId.startsWith('proj-'), firstId);

// Edit: new image, a preset, a rename, a background change.
await page.evaluate(() => window.__glyphix.select(null));
await page.evaluate(async () => {
  const c = new OffscreenCanvas(800, 500);
  const g = c.getContext('2d');
  g.fillStyle = '#0ea5e9';
  g.fillRect(0, 0, 800, 500);
  g.fillStyle = '#fff';
  g.font = 'bold 64px sans-serif';
  g.fillText('persist me', 60, 260);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'persist.png', { type: 'image/png' }));
  window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
await page.waitForFunction(() => window.__glyphix.state().doc.comp.layers.length === 4);
await page.getByRole('group', { name: 'Enter animation' }).getByRole('button', { name: 'Pop', exact: true }).click();
await page.getByLabel('Project name').fill('E2E project');
await page.keyboard.press('Enter');
await page.evaluate(() => window.__glyphix.select(null));
await page.getByRole('button', { name: 'Solid', exact: true }).click();
await page.waitForTimeout(1200);
await saved();
const before = await docJson();
const imgId = JSON.parse(before).comp.layers[3].assetId;

// Reload: same doc, same images, nothing left to undo.
await page.reload();
await ready();
const after = await docJson();
check('reload restores the identical document', before === after, `${(before.length / 1024).toFixed(1)} KB JSON`);
check('reload restores the dropped image', await page.evaluate((id) => window.__glyphix.assets().includes(id), imgId), imgId);
check('demo screenshot (canvas-only asset) restored as PNG', await page.evaluate(() => window.__glyphix.assets().includes('demo-screenshot')));
check('project name restored', (await page.getByLabel('Project name').inputValue()) === 'E2E project');
check('restored project starts with empty history', await page.getByRole('button', { name: /^Undo/ }).isDisabled());

// An old (schema v1) project in storage is migrated on load.
await page.evaluate(async () => {
  // Pre-v9 documents hold plain values where v9 has static Props (numbers were already Props): flatten those fields.
  const doc = JSON.parse(JSON.stringify(window.__glyphix.state().doc));
  const un = (v) => (v && typeof v === 'object' && 'static' in v ? v.static : v);
  const flat = (o, keys) => o && keys.forEach((k) => k in o && (o[k] = un(o[k])));
  for (const l of doc.comp.layers) {
    for (const e of l.effects ?? []) for (const k of Object.keys(e.colors ?? {})) e.colors[k] = un(e.colors[k]);
    if (l.type === 'background') {
      flat(l.fill, ['color', 'angle']);
      l.fill.stops?.forEach((s) => flat(s, ['offset', 'color']));
      l.fill.points?.forEach((p) => flat(p, ['x', 'y', 'color']));
    } else if (l.type === 'image') {
      flat(l, ['radius']);
      flat(l.shadow, ['blur', 'offsetX', 'offsetY', 'color']);
      flat(l.border, ['width', 'color']);
    } else if (l.type === 'text') {
      flat(l, ['text', 'color', 'glowColor']);
      flat(l.gradient, ['angle', 'from', 'to']);
      flat(l.outline, ['width', 'color']);
      flat(l.shadow, ['offsetX', 'offsetY', 'blur', 'color']);
    }
  }
  doc.schemaVersion = 1;
  doc.id = 'proj-v1-fixture';
  doc.name = 'Old project';
  doc.comp.layers.forEach((l) => delete l.motion);
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('glyphix');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  await new Promise((res, rej) => {
    const tx = db.transaction(['projects', 'meta'], 'readwrite');
    tx.objectStore('projects').put({ id: doc.id, name: doc.name, createdAt: 1, updatedAt: Date.now(), doc });
    tx.objectStore('meta').put({ key: 'lastProject', value: doc.id });
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
  db.close();
});
await page.reload();
await ready();
const migrated = await page.evaluate(() => window.__glyphix.state().doc);
check('v1 project migrated on load', migrated.id === 'proj-v1-fixture' && migrated.schemaVersion === 9 && migrated.comp.layers[2].timing?.out === null && Array.isArray(migrated.comp.layers[0].effects) && migrated.comp.layers[1].motion?.exit === null && migrated.comp.layers[2].weight === 400, `schema ${migrated.schemaVersion}`);

// A missing image warns but still opens the document.
await page.evaluate(async (id) => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('glyphix');
    r.onsuccess = () => res(r.result);
  });
  await new Promise((res) => {
    const tx = db.transaction('assets', 'readwrite');
    tx.objectStore('assets').delete(id);
    tx.oncomplete = res;
  });
  db.close();
}, imgId);
await page.reload();
await ready();
const alert = await page.getByRole('alert').textContent().catch(() => '');
check('missing image → warning, doc still opens', /missing/.test(alert) && (await page.evaluate(() => window.__glyphix.state().doc.id)) === 'proj-v1-fixture', alert);

console.log(errors.length ? `page errors:\n${errors.slice(0, 10).join('\n')}` : 'no page errors');
if (errors.length) failures++;
await browser.close();
process.exit(failures ? 1 : 0);
