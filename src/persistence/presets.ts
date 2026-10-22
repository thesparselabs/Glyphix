// The user's saved animation presets (IndexedDB store `presets`, one record per preset, keyed by id).
import { PRESET_FILE_FORMAT, PRESET_FILE_VERSION, parsePresetFile, type Animation, type AnimPreset } from '@/doc';
import { del, getAll, put, putMany } from './db';

export const newPresetId = () => `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/** Oldest first. A record that no longer validates is left out (it stays in the database untouched). */
export async function listPresets(): Promise<AnimPreset[]> {
  const out: AnimPreset[] = [];
  for (const rec of await getAll<unknown>('presets')) {
    try {
      out.push(...parsePresetFile({ format: PRESET_FILE_FORMAT, version: PRESET_FILE_VERSION, presets: [rec] }));
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export async function savePreset(name: string, anim: Animation): Promise<AnimPreset> {
  const preset: AnimPreset = { ...JSON.parse(JSON.stringify(anim)), id: newPresetId(), name: name.trim() || 'Untitled animation', createdAt: Date.now() };
  await put('presets', preset);
  return preset;
}

export async function renamePreset(id: string, name: string): Promise<void> {
  const current = (await listPresets()).find((p) => p.id === id);
  if (current && name.trim()) await put('presets', { ...current, name: name.trim() });
}

export const deletePreset = (id: string) => del('presets', [id]);

/** Add imported presets; ones whose id is already taken get a new id. Returns what was stored. */
export async function importPresets(incoming: AnimPreset[]): Promise<AnimPreset[]> {
  const taken = new Set((await listPresets()).map((p) => p.id));
  const stored = incoming.map((p) => {
    const id = taken.has(p.id) ? newPresetId() : p.id;
    taken.add(id);
    return { ...p, id };
  });
  await putMany('presets', stored);
  return stored;
}
