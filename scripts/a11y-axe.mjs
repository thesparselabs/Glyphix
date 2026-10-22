// Accessibility audit with axe-core (the engine Lighthouse uses) in editor states Lighthouse can't
// reach on its own: text layer selected, font picker open, each animation tab.
// Usage: AXE=/path/to/axe.min.js node scripts/a11y-axe.mjs [baseUrl]
import { readFileSync } from 'node:fs';
import { launch } from './browser.mjs';

const base = process.argv[2] ?? 'http://localhost:5173';
const axe = readFileSync(process.env.AXE, 'utf8');
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(base);
await page.waitForFunction(() => window.__glyphix && window.__glyphix.saveState() === 'saved');
await page.keyboard.press('Space');
await page.addScriptTag({ content: axe });
let failures = 0;
async function audit(name) {
  const r = await page.evaluate(async () => {
    const res = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return res.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  });
  console.log(`${r.length ? 'FAIL' : 'PASS'} ${name}${r.length ? `\n  ${r.join('\n  ')}` : ''}`);
  if (r.length) failures++;
}
await audit('nothing selected');
await page.evaluate(() => window.__glyphix.select('headline'));
await page.waitForTimeout(400);
await audit('text layer selected (enter tab)');
for (const tab of ['Exit', 'Loop']) {
  await page.getByRole('tab', { name: new RegExp(tab) }).click();
  await page.waitForTimeout(300);
  await audit(`animation ${tab.toLowerCase()} tab`);
}
// Saved animations: save the headline's animation, then audit the tab with a preset listed (and one being renamed).
await page.getByRole('tab', { name: 'Saved' }).click();
await page.getByLabel('Preset name').fill('Axe preset');
await page.getByRole('button', { name: /^Save/ }).click();
await page.getByRole('button', { name: 'Apply Axe preset' }).waitFor();
await page.waitForTimeout(300);
await audit('animation: saved presets');
await page.getByRole('button', { name: 'Rename Axe preset' }).click();
await page.waitForTimeout(200);
await audit('animation: saved presets (renaming)');
await page.keyboard.press('Escape');
await page.getByRole('tab', { name: /Enter/ }).click();
await page.getByRole('switch', { name: 'Outline' }).click();
await page.getByRole('switch', { name: 'Text shadow' }).click();
await page.getByRole('group', { name: 'Fill type' }).getByRole('button', { name: 'Gradient' }).click();
await page.waitForTimeout(300);
await audit('outline, shadow, gradient controls');
await page.getByRole('button', { name: /^Font:/ }).click();
await page.waitForTimeout(800);
await audit('font picker open');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
// Effects: menu open, then cards with every control kind (sliders, keyframes, colours, toggles).
await page.getByRole('button', { name: 'Add effect' }).click();
await page.waitForTimeout(400);
await audit('add effect menu open');
await page.getByRole('menuitem', { name: /^Glow/ }).click();
for (const fx of ['Grain', 'Gradient map']) {
  await page.getByRole('button', { name: 'Add effect' }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${fx}`) }).click();
}
await page.getByRole('button', { name: 'Add Glow radius keyframe at playhead' }).click();
await page.waitForTimeout(300);
await audit('effect cards (glow keyframed, grain, gradient map)');
await page.getByRole('button', { name: 'Add adjustment layer' }).click();
await page.waitForTimeout(300);
await audit('adjustment layer selected');
// Video layer: the Video section (needs scripts/fixtures; skipped without them).
const hasFixture = await page.evaluate(async () => (await fetch('/scripts/fixtures/clip-1080p30.mp4', { method: 'HEAD' })).ok);
if (hasFixture) {
  await page.evaluate(async () => {
    const { importVideo } = window.__glyphix.video;
    const { id } = await importVideo(await (await fetch('/scripts/fixtures/clip-1080p30.mp4')).blob());
    const ed = window.__glyphix.editor.getState();
    const i = ed.doc.comp.layers.findIndex((l) => l.id === 'shot');
    ed.set('video', [{ path: ['comp', 'layers', i, 'assetId'], value: id }, { path: ['comp', 'layers', i, 'video'], value: { start: 0, in: 0, out: 5, loop: false, volume: 1, muted: false } }]);
    window.__glyphix.select('shot');
  });
  await page.waitForTimeout(500);
  await audit('video layer selected (Video section)');
} else console.log('SKIP video layer — run scripts/make-video-fixtures.sh');
// ASCII Studio: the ASCII card (look, font, custom characters) on the screenshot layer, then the export
// dialog's ASCII text section.
// Timeline: property rows open, a keyframe selected, the easing editor, then the panel collapsed.
await page.getByRole('button', { name: 'Show Screenshot properties' }).click();
await page.getByRole('list', { name: 'Screenshot properties' }).getByRole('button', { name: /^Opacity keyframe at 0\.80/ }).click();
await page.waitForTimeout(300);
await audit('timeline: properties open, keyframe selected');
// Easing editor on the first opacity key: curve with handles, then the spring controls.
await page.getByRole('list', { name: 'Screenshot properties' }).getByRole('button', { name: /^Opacity keyframe at 0\.00/ }).click();
await page.keyboard.press('e');
const easingPresets = page.getByRole('group', { name: 'Easing presets' });
await easingPresets.getByRole('button', { name: 'CSS ease', exact: true }).click();
await page.waitForTimeout(400);
await audit('easing editor: curve handles');
await easingPresets.getByRole('button', { name: 'Spring', exact: true }).click();
await page.waitForTimeout(300);
await audit('easing editor: spring');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Collapse timeline' }).click();
await page.waitForTimeout(300);
await audit('timeline collapsed');
await page.getByRole('button', { name: 'Expand timeline' }).click();
await page.keyboard.press('Escape');
await page.evaluate(() => window.__glyphix.select('shot'));
await page.getByRole('button', { name: 'Add effect' }).click();
await page.getByRole('menuitem', { name: /^ASCII/ }).click();
await page.getByRole('combobox', { name: 'ASCII characters' }).click();
await page.getByRole('option', { name: 'Custom' }).click();
await page.waitForTimeout(300);
await audit('ASCII card (look, font, custom characters)');
await page.keyboard.press('Control+e');
const dialog = page.getByRole('dialog', { name: 'Export' });
await dialog.waitFor();
await dialog.getByRole('group', { name: 'Format' }).getByRole('button', { name: 'ASCII text', exact: true }).click();
await page.waitForTimeout(500);
await audit('export dialog: ASCII text');
await dialog.getByRole('group', { name: 'Format' }).getByRole('button', { name: 'Lottie', exact: true }).click();
await page.waitForTimeout(300);
await audit('export dialog: Lottie');
await dialog.getByRole('button', { name: /^Export / }).click();
await dialog.getByRole('list', { name: /Left out/ }).waitFor({ timeout: 60000 });
await audit('export dialog: Lottie result with "Left out" list');
await browser.close();
process.exit(failures ? 1 : 0);
