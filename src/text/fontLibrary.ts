import { coverageToSDF } from './sdf';
import { bundledFont, DEFAULT_FONT_ID, effectiveWeight, type FontInfo } from './fonts';

/** Atlas resolution: pixels per em, and SDF spread in px (also the glyph cell padding). */
export const ATLAS_EM_PX = 64;
export const ATLAS_SPREAD_PX = 16;
/** Spread in em: how far outlines, shadows and glow can reach from the glyph edge. */
export const ATLAS_SPREAD_EM = ATLAS_SPREAD_PX / ATLAS_EM_PX;
/** Atlas pages are ATLAS_SIZE² R8 layers of one array texture, added on demand. */
export const ATLAS_SIZE = 2048;
export const ATLAS_MAX_PAGES = 8;
const PAGE_BYTES = ATLAS_SIZE * ATLAS_SIZE;

export interface AtlasGlyph {
  /** Atlas page (array texture layer). */
  page: number;
  /** Texel rect within the page. */
  ax: number;
  ay: number;
  aw: number;
  ah: number;
  /** Quad rect relative to the pen origin, in em, font y-up (left, bottom, right, top). */
  l: number;
  b: number;
  r: number;
  t: number;
}

export interface LaidOutGlyph {
  /** Pen origin in em, y-up, relative to the text block centre. */
  x: number;
  y: number;
  /** Horizontal advance in em (including tracking). */
  advance: number;
  glyph: AtlasGlyph | null; // null = whitespace / empty outline
  /** Shaped glyph id in the font (outlines by id: glyphPath). */
  gid: number;
  /** Index of the source character (cluster) in the text. */
  cluster: number;
  line: number;
}

export interface TextLayout {
  glyphs: LaidOutGlyph[];
  /** Block size in em. */
  width: number;
  height: number;
  /** Font actually used (the requested one, or the fallback when it is missing). */
  fontId: string;
  /** Atlas generation the glyph rects belong to. */
  generation: number;
}

export interface LayoutSpec {
  fontId: string;
  weight: number;
  text: string;
  tracking: number;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
}

interface FontFile {
  face: import('harfbuzzjs').Face;
  upem: number;
  info: FontInfo;
  instances: Map<number, FontInstance>;
}

interface FontInstance {
  font: import('harfbuzzjs').Font;
  ascender: number;
  descender: number;
  glyphs: Map<number, AtlasGlyph | null>;
}

type HB = typeof import('harfbuzzjs');

/**
 * Owns shaping (HarfBuzz) and the shared SDF glyph atlas (CPU side).
 * The atlas is a stack of pages (`pages` layers of ATLAS_SIZE², contiguous in `atlas`). Renderers
 * re-upload a page when its entry in `pageVersions` changes, and rebuild their array texture when
 * `pages` grows. When every page is full the atlas is cleared and `generation` bumps: every cached
 * layout from an older generation must be laid out again.
 */
/** Text layouts kept for reuse (see layout()). */
const MAX_CACHED_LAYOUTS = 512;

export class FontLibrary {
  atlas = new Uint8Array(PAGE_BYTES);
  readonly atlasSize = ATLAS_SIZE;
  pages = 1;
  /** Bumps per page when its pixels change. */
  pageVersions = [0];
  /** Bumps on any atlas change (cheap "anything new?" check). */
  atlasVersion = 0;
  generation = 0;

  private hb: Promise<HB> | null = null;
  private hbModule: HB | null = null;
  private files = new Map<string, FontFile>();
  private loading = new Map<string, Promise<void>>();
  private userFonts = new Map<string, { info: FontInfo; bytes: ArrayBuffer }>();
  private failed = new Set<string>();
  private layoutCache = new Map<string, TextLayout>();
  private listeners = new Set<() => void>();
  private shelfX = 0;
  private shelfY = 0;
  private shelfH = 0;
  private raster: OffscreenCanvasRenderingContext2D | null = null;

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  /** Font metadata (bundled or registered user font). */
  info(fontId: string): FontInfo | undefined {
    return bundledFont(fontId) ?? this.userFonts.get(fontId)?.info;
  }

  userFontList(): FontInfo[] {
    return [...this.userFonts.values()].map((u) => u.info);
  }

  isLoaded(fontId: string): boolean {
    return this.files.has(fontId);
  }

  /** True when the font can't be loaded (unknown id or broken file): layouts fall back to Inter. */
  isMissing(fontId: string): boolean {
    return this.failed.has(fontId) || (!bundledFont(fontId) && !this.userFonts.has(fontId));
  }

  /** Read a font file's family name and weight axis; null if HarfBuzz can't use it. */
  async inspect(bytes: ArrayBuffer): Promise<{ family: string; weights: FontInfo['weights'] } | null> {
    this.hb ??= import('harfbuzzjs');
    const hb = await this.hb;
    try {
      const face = new hb.Face(new hb.Blob(bytes));
      if (!face.upem || face.collectUnicodes().length === 0) return null;
      const name = (id: number) => {
        try {
          return face.getName(id, 'en').trim();
        } catch {
          return '';
        }
      };
      const family = (name(16) || name(1) || 'Uploaded font').slice(0, 80);
      const w = face.getAxisInfos().wght;
      return { family, weights: w ? { min: w.min, max: w.max, default: w.default } : null };
    } catch {
      return null;
    }
  }

  /** Make an uploaded font available under its asset id. */
  registerUserFont(id: string, family: string, bytes: ArrayBuffer, weights: FontInfo['weights']) {
    if (this.userFonts.has(id)) return;
    this.userFonts.set(id, { info: { id, family, category: 'sans', weights, user: true }, bytes });
    this.failed.delete(id);
    this.emit();
  }

  load(fontId: string): Promise<void> {
    const existing = this.loading.get(fontId);
    if (existing) return existing;
    const info = this.info(fontId);
    if (!info) return Promise.reject(new Error(`Unknown font: ${fontId}`));
    const p = (async () => {
      this.hb ??= import('harfbuzzjs');
      const user = this.userFonts.get(fontId);
      const [hb, data] = await Promise.all([this.hb, user ? Promise.resolve(user.bytes) : fetch(info.url!).then((r) => r.arrayBuffer())]);
      const face = new hb.Face(new hb.Blob(data));
      this.files.set(fontId, { face, upem: face.upem, info, instances: new Map() });
      this.hbModule = hb;
      this.emit();
    })();
    p.catch((e) => {
      console.warn(`[glyphix] font ${fontId} failed to load`, e);
      this.failed.add(fontId);
      this.loading.delete(fontId);
      this.emit();
    });
    this.loading.set(fontId, p);
    return p;
  }

  /** Load every font, falling back silently (missing fonts render in Inter). */
  async loadAll(fontIds: Iterable<string>): Promise<void> {
    const ids = new Set([DEFAULT_FONT_ID, ...fontIds]);
    await Promise.all([...ids].filter((id) => !this.isMissing(id)).map((id) => this.load(id).catch(() => undefined)));
  }

  /** Synchronous layout. Returns null (and starts loading) if the font isn't ready yet. */
  layout(spec: LayoutSpec): TextLayout | null {
    const fontId = this.isMissing(spec.fontId) ? DEFAULT_FONT_ID : spec.fontId;
    const file = this.files.get(fontId);
    if (!file || !this.hbModule) {
      void this.load(fontId).catch(() => undefined);
      return null;
    }
    const weight = effectiveWeight(file.info, spec.weight);
    const key = `${fontId}\u0000${weight}\u0000${spec.tracking}\u0000${spec.align}\u0000${spec.lineHeight}\u0000${spec.text}`;
    const cached = this.layoutCache.get(key);
    if (cached && cached.generation === this.generation) return cached;
    // If the atlas fills up (and resets) part-way, glyphs placed before the reset are gone: lay out again.
    for (let attempt = 0; attempt < 2; attempt++) {
      const gen = this.generation;
      const result = this.shape(file, weight, spec, fontId);
      if (gen === this.generation) {
        // A frame counter makes a new text every frame: keep the cache from growing without bound (oldest first).
        if (this.layoutCache.size >= MAX_CACHED_LAYOUTS) this.layoutCache.delete(this.layoutCache.keys().next().value!);
        this.layoutCache.set(key, result);
        return result;
      }
    }
    console.warn('[glyphix] text needs more glyphs than the atlas holds');
    return this.shape(file, weight, spec, fontId);
  }

  private instance(file: FontFile, weight: number): FontInstance {
    let inst = file.instances.get(weight);
    if (inst) return inst;
    const hb = this.hbModule!;
    const font = new hb.Font(file.face);
    if (file.info.weights) font.setVariations([new hb.Variation('wght', weight)]);
    const ext = font.hExtents();
    inst = { font, ascender: ext.ascender, descender: ext.descender, glyphs: new Map() };
    file.instances.set(weight, inst);
    return inst;
  }

  private shape(file: FontFile, weight: number, spec: LayoutSpec, fontId: string): TextLayout {
    const hb = this.hbModule!;
    const f = this.instance(file, weight);
    const upem = file.upem;
    const lines = spec.text.split('\n');
    const shaped: { glyphs: LaidOutGlyph[]; width: number }[] = [];
    let lineStart = 0;
    lines.forEach((line, li) => {
      const buf = new hb.Buffer();
      buf.addText(line);
      buf.guessSegmentProperties();
      hb.shape(f.font, buf);
      const infos = buf.getGlyphInfos();
      const pos = buf.getGlyphPositions();
      const glyphs: LaidOutGlyph[] = [];
      let pen = 0;
      for (let i = 0; i < infos.length; i++) {
        const p = pos[i]!;
        const advance = p.xAdvance + spec.tracking * upem;
        glyphs.push({
          x: (pen + p.xOffset) / upem,
          y: p.yOffset / upem,
          advance: advance / upem,
          glyph: this.glyph(f, upem, infos[i]!.codepoint),
          gid: infos[i]!.codepoint,
          cluster: lineStart + infos[i]!.cluster,
          line: li,
        });
        pen += advance;
      }
      const width = Math.max(0, pen - (infos.length ? spec.tracking * upem : 0)) / upem;
      shaped.push({ glyphs, width });
      lineStart += line.length + 1;
    });
    const asc = f.ascender / upem;
    const desc = -f.descender / upem;
    const lh = spec.lineHeight * (asc + desc);
    const blockW = Math.max(0, ...shaped.map((l) => l.width));
    const blockH = asc + desc + lh * (lines.length - 1);
    const out: LaidOutGlyph[] = [];
    shaped.forEach((line, li) => {
      const dx = spec.align === 'left' ? -blockW / 2 : spec.align === 'right' ? blockW / 2 - line.width : -line.width / 2;
      const baseline = blockH / 2 - asc - li * lh;
      for (const g of line.glyphs) out.push({ ...g, x: g.x + dx, y: g.y + baseline });
    });
    return { glyphs: out, width: blockW, height: blockH, fontId, generation: this.generation };
  }

  /**
   * Outline of one character of a loaded font (the ASCII effect rasterises these itself): a HarfBuzz path
   * in font units, y up ('' for blank glyphs). null when the font isn't loaded; `found` false when the
   * font has no glyph for it.
   */
  outline(fontId: string, weight: number, ch: string): { path: string; advance: number; upem: number; ascender: number; descender: number; found: boolean } | null {
    const file = this.files.get(fontId);
    if (!file) return null;
    const f = this.instance(file, effectiveWeight(file.info, weight));
    const gid = f.font.glyph(ch.codePointAt(0)!) ?? 0;
    return {
      path: gid ? f.font.glyphToPath(gid) : '',
      advance: f.font.glyphHAdvance(gid),
      upem: file.upem,
      ascender: f.ascender,
      descender: f.descender,
      found: gid !== 0,
    };
  }

  /**
   * Outline of a shaped glyph (by glyph id, as in LaidOutGlyph.gid): path commands in font units, y up
   * (M/L/Q/C/Z). null when the font isn't loaded.
   */
  glyphPath(fontId: string, weight: number, gid: number): { commands: { type: string; values: number[] }[]; upem: number } | null {
    const file = this.files.get(fontId);
    if (!file) return null;
    const f = this.instance(file, effectiveWeight(file.info, weight));
    return { commands: f.font.glyphToJson(gid), upem: file.upem };
  }

  /** Atlas rect of one glyph of a loaded font (scramble charsets use this). */
  glyphFor(fontId: string, weight: number, codepoint: number): { glyph: AtlasGlyph | null; advance: number } | null {
    const file = this.files.get(fontId);
    if (!file) return null;
    const f = this.instance(file, effectiveWeight(file.info, weight));
    const gid = f.font.glyph(codepoint);
    if (gid === undefined) return null;
    return { glyph: this.glyph(f, file.upem, gid), advance: f.font.glyphHAdvance(gid) / file.upem };
  }

  private glyph(f: FontInstance, upem: number, gid: number): AtlasGlyph | null {
    if (f.glyphs.has(gid)) return f.glyphs.get(gid)!;
    const ext = f.font.glyphExtents(gid);
    const path = f.font.glyphToPath(gid);
    if (!ext || !path || ext.width === 0) {
      f.glyphs.set(gid, null);
      return null;
    }
    const s = ATLAS_EM_PX / upem;
    const pad = ATLAS_SPREAD_PX;
    // Glyph bbox in font units (y-up): x ∈ [xBearing, xBearing+width], y ∈ [yBearing+height, yBearing].
    const x0 = ext.xBearing;
    const y1 = ext.yBearing;
    const w = Math.ceil(ext.width * s) + 2 * pad;
    const h = Math.ceil(-ext.height * s) + 2 * pad;
    let slot = this.allocate(w, h);
    if (!slot && this.pages < ATLAS_MAX_PAGES) {
      this.addPage();
      slot = this.allocate(w, h);
    }
    if (!slot) {
      this.reset();
      slot = this.allocate(w, h);
      if (!slot) {
        f.glyphs.set(gid, null);
        return null;
      }
    }

    const ctx = this.rasterCtx(w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // font units → cell px, flipping y.
    ctx.setTransform(s, 0, 0, -s, pad - x0 * s, pad + y1 * s);
    ctx.fillStyle = '#fff';
    ctx.fill(new Path2D(path));
    const img = ctx.getImageData(0, 0, w, h).data;
    const sdf = coverageToSDF(img.subarray(3), w, h, ATLAS_SPREAD_PX, 4);
    const base = slot.page * PAGE_BYTES;
    for (let row = 0; row < h; row++) {
      this.atlas.set(sdf.subarray(row * w, row * w + w), base + (slot.y + row) * ATLAS_SIZE + slot.x);
    }
    this.pageVersions[slot.page]!++;
    this.atlasVersion++;

    const g: AtlasGlyph = {
      page: slot.page,
      ax: slot.x,
      ay: slot.y,
      aw: w,
      ah: h,
      l: x0 / upem - pad / ATLAS_EM_PX,
      t: y1 / upem + pad / ATLAS_EM_PX,
      r: x0 / upem - pad / ATLAS_EM_PX + w / ATLAS_EM_PX,
      b: y1 / upem + pad / ATLAS_EM_PX - h / ATLAS_EM_PX,
    };
    f.glyphs.set(gid, g);
    return g;
  }

  private addPage() {
    const next = new Uint8Array(PAGE_BYTES * (this.pages + 1));
    next.set(this.atlas);
    this.atlas = next;
    this.pages++;
    this.pageVersions.push(0);
    this.shelfX = this.shelfY = this.shelfH = 0;
    this.atlasVersion++;
  }

  /** Empty the atlas (back to one page). Glyphs are re-rasterised on demand by the next layouts. */
  private reset() {
    console.info('[glyphix] glyph atlas full: rebuilding');
    this.atlas = new Uint8Array(PAGE_BYTES);
    this.pages = 1;
    this.pageVersions = [this.pageVersions[0]! + 1];
    this.shelfX = this.shelfY = this.shelfH = 0;
    this.files.forEach((file) => file.instances.forEach((inst) => inst.glyphs.clear()));
    this.layoutCache.clear();
    this.generation++;
    this.atlasVersion++;
  }

  private rasterCtx(w: number, h: number): OffscreenCanvasRenderingContext2D {
    if (!this.raster || this.raster.canvas.width < w || this.raster.canvas.height < h) {
      const c = new OffscreenCanvas(Math.max(w, 256), Math.max(h, 256));
      this.raster = c.getContext('2d', { willReadFrequently: true })!;
    }
    return this.raster;
  }

  /** Shelf packer on the last page. */
  private allocate(w: number, h: number): { page: number; x: number; y: number } | null {
    if (this.shelfX + w > ATLAS_SIZE) {
      this.shelfX = 0;
      this.shelfY += this.shelfH + 1;
      this.shelfH = 0;
    }
    if (this.shelfY + h > ATLAS_SIZE) return null;
    const slot = { page: this.pages - 1, x: this.shelfX, y: this.shelfY };
    this.shelfX += w + 1;
    this.shelfH = Math.max(this.shelfH, h);
    return slot;
  }
}

export const fontLibrary = new FontLibrary();
