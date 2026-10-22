import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/wensity/dialog';
import { Progress } from '@/components/wensity/progress';
import { Switch } from '@/components/wensity/switch';
import { audioSegments } from '@/doc';
import { downloadBlob, runExport, type ExportFormat, type ExportResult, type ExportSettings } from '@/export/exporter';
import { defaultAsciiEffect, estimateAsciiBytes, frameCount as asciiFrameCount, listAsciiEffects, loadAsciiFontBytes, captureAsciiSequence, runAsciiExport, type AsciiOutput } from '@/export/asciiText';
import { useEditor } from './store';
import { Button, PresetGrid, SelectField, SliderField } from './ui';

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
  { value: 'gif', label: 'GIF' },
  { value: 'mp4', label: 'MP4 video' },
  { value: 'webm', label: 'WebM (transparent)' },
  { value: 'png-seq', label: 'PNG sequence (.zip)' },
  { value: 'lottie', label: 'Lottie' },
];

/** The ASCII text export is a dialog format of its own (it has no scale, and only exists when the doc has an ASCII effect). */
const ASCII_FORMAT = 'ascii';
type DialogFormat = ExportFormat | typeof ASCII_FORMAT;
type DialogSettings = Omit<ExportSettings, 'time' | 'format'> & { format: DialogFormat };
const ASCII_OUTPUTS: { value: AsciiOutput; label: string }[] = [
  { value: 'copy', label: 'Copy frame' },
  { value: 'txt-zip', label: 'TXT frames (.zip)' },
  { value: 'json', label: 'JSON' },
  { value: 'html', label: 'HTML player' },
  { value: 'react', label: 'React component (.zip)' },
];

type Kind = 'still' | 'video' | 'sequence' | 'gif';
const SCALES: Record<Kind, number[]> = { still: [1, 2, 3, 4], video: [0.5, 1, 2], sequence: [0.5, 1, 2], gif: [0.25, 0.5, 0.75, 1] };
const kind = (f: ExportFormat): Kind => (f === 'mp4' || f === 'webm' ? 'video' : f === 'png-seq' ? 'sequence' : f === 'gif' ? 'gif' : 'still');
/** H.264/VP9 encoders top out around 4096 px wide on common hardware. */
const MAX_VIDEO_DIM = 4096;

const DEFAULTS: DialogSettings = { format: 'png', scale: 1, quality: 0.92, transparent: false, webmTransparent: true, gifFps: 20 };
const STORAGE_KEY = 'glyphix.exportSettings';

function loadSettings(): DialogSettings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<ExportSettings>) };
  } catch {
    return DEFAULTS; // storage blocked/private mode: defaults are fine
  }
}

function saveSettings(s: DialogSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* per-viewer convenience only */
  }
}

const fmtBytes = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export function ExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const comp = useEditor((s) => s.doc.comp);
  const time = useEditor((s) => s.time);
  const forceWebGL = useEditor((s) => s.forceWebGL);
  const doc = useEditor((s) => s.doc);
  const [settings, setSettings] = useState(loadSettings);
  const [ascii, setAscii] = useState<{ effectId: string; output: AsciiOutput; sound: boolean }>({ effectId: '', output: 'copy', sound: false });
  const [message, setMessage] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const asciiEffects = useMemo(() => listAsciiEffects(doc), [doc]);
  const hasAudio = useMemo(() => audioSegments(doc).length > 0, [doc]);
  const effectId = asciiEffects.some((r) => r.effect.id === ascii.effectId) ? ascii.effectId : (defaultAsciiEffect(doc)?.effect.id ?? '');
  // A saved "ASCII text" choice falls back to PNG in a doc without an ASCII effect.
  const fmt: DialogFormat = settings.format === ASCII_FORMAT && !asciiEffects.length ? 'png' : settings.format;
  const isAscii = fmt === ASCII_FORMAT;
  const isLottie = fmt === 'lottie';
  const k = kind(isAscii ? 'png-seq' : (fmt as ExportFormat));
  const scales = SCALES[k].filter((s) => k !== 'video' || Math.max(comp.width, comp.height) * s <= MAX_VIDEO_DIM);
  const scale = scales.includes(settings.scale) ? settings.scale : (scales.find((s) => s === 1) ?? scales[0]!);
  const w = Math.round(comp.width * scale);
  const h = Math.round(comp.height * scale);
  const frameCount = Math.max(1, Math.round(comp.duration * comp.fps));

  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => {
    if (open) {
      setResult(null);
      setError(null);
      setMessage(null);
    }
  }, [open]);

  // Size estimate: one probe frame gives the grid size and colour mode; the rest is arithmetic.
  const effect = asciiEffects.find((r) => r.effect.id === effectId)?.effect;
  const effectKey = effect ? JSON.stringify([effect, comp.width, comp.height]) : '';
  const sendsFile = ascii.output !== 'copy';
  useEffect(() => {
    setEstimate(null);
    if (!open || !isAscii || !sendsFile || !effect) return;
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        const { doc: d } = useEditor.getState();
        const { sequence } = await captureAsciiSequence(d, effectId, { forceWebGL, times: [Math.min(time, comp.duration)] });
        const fontBytes = ascii.output === 'html' || ascii.output === 'react' ? (await loadAsciiFontBytes(effect.text.fontId ?? '')).length : 0;
        const bytes = estimateAsciiBytes({
          cols: sequence.cols,
          rows: sequence.rows,
          frames: asciiFrameCount(d),
          color: !sequence.mono,
          output: ascii.output as Exclude<AsciiOutput, 'copy'>,
          fontBytes,
          audioSeconds: ascii.sound && hasAudio ? d.comp.duration : 0,
        });
        if (!stale) setEstimate(bytes);
      } catch {
        /* no estimate: the export itself reports the problem */
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- effectKey stands for the effect and comp size
  }, [open, isAscii, sendsFile, effectKey, ascii.output, ascii.sound, hasAudio, forceWebGL]);

  const update = (patch: Partial<typeof settings>) => setSettings((s) => ({ ...s, ...patch }));

  const startAscii = async (ac: AbortController) => {
    const { doc: d } = useEditor.getState();
    const run = (): Promise<Awaited<ReturnType<typeof runAsciiExport>>> =>
      runAsciiExport(d, { effectId, output: ascii.output, sound: ascii.sound && hasAudio, time }, { forceWebGL, signal: ac.signal, onProgress: setProgress });
    if (ascii.output === 'copy') {
      // Handing the clipboard a promise keeps the click's permission alive while the frame renders.
      const job = run();
      if (typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': job.then((r) => new Blob([r.text!], { type: 'text/plain' })) })]);
      } else {
        await navigator.clipboard.writeText((await job).text!);
      }
      setMessage(`Copied the ASCII at ${time.toFixed(2)}s to the clipboard.`);
      return;
    }
    const r = await run();
    downloadBlob(r.blob!, r.filename);
    setMessage(`Saved ${r.filename} · ${r.frames} frames · ${fmtBytes(r.blob!.size)} · ${(r.ms / 1000).toFixed(1)}s${r.notes.length ? ` · ${r.notes.join(' ')}` : ''}`);
  };

  const start = async () => {
    const ac = new AbortController();
    abort.current = ac;
    setProgress(0);
    setResult(null);
    setError(null);
    setMessage(null);
    try {
      const { doc, setPlaying } = useEditor.getState();
      setPlaying(false); // the playing preview competes for the main thread and GPU (export runs ~realtime alone)
      if (isAscii) return await startAscii(ac);
      const r = await runExport(doc, { ...settings, format: fmt as ExportFormat, scale, time }, { forceWebGL, signal: ac.signal, onProgress: setProgress });
      downloadBlob(r.blob, r.filename);
      setResult(r);
    } catch (e) {
      setError((e as Error).name === 'AbortError' ? 'Export cancelled.' : `Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProgress(null);
      abort.current = null;
    }
  };

  const busy = progress !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && busy) abort.current?.abort(); // closing cancels a running export
        onOpenChange(o);
      }}
    >
      <DialogContent variant="form">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
          <DialogDescription>
            {isLottie
              ? `The whole ${comp.duration}s as a Lottie animation (.json): text as vector shapes, images embedded.`
              : isAscii
              ? ascii.output === 'copy'
                ? `The ASCII at ${time.toFixed(2)}s as plain text, cell for cell as drawn.`
                : `${frameCount} frames (${comp.duration}s at ${comp.fps} fps) of text, cell for cell as drawn.`
              : k === 'still'
              ? `The frame at ${time.toFixed(2)}s, exactly as previewed.`
              : k === 'sequence'
                ? `${frameCount} frames (${comp.duration}s at ${comp.fps} fps), each exactly as previewed.`
                : `The whole ${comp.duration}s, frame by frame, exactly as previewed.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <PresetGrid<DialogFormat>
            label="Format"
            value={fmt}
            options={asciiEffects.length ? [...FORMATS, { value: ASCII_FORMAT, label: 'ASCII text' }] : FORMATS}
            onChange={(format) => update({ format })}
            columns={4}
          />
          {isAscii && (
            <>
              <SelectField label="ASCII effect" value={effectId} options={asciiEffects.map((r) => ({ value: r.effect.id, label: r.label }))} onValueChange={(id) => setAscii((a) => ({ ...a, effectId: id }))} />
              <PresetGrid label="Output" value={ascii.output} options={ASCII_OUTPUTS} onChange={(output) => setAscii((a) => ({ ...a, output }))} columns={3} />
              {(ascii.output === 'html' || ascii.output === 'react') && hasAudio && (
                <Switch switchSize="sm" checked={ascii.sound} onCheckedChange={(sound) => setAscii((a) => ({ ...a, sound }))} label="Include sound" labelClassName="text-sm text-zinc-300" />
              )}
              <p className="text-xs text-dim">
                {ascii.output === 'copy' ? 'Copies the text of the current frame.' : `Text of the chosen effect only (other layers are not text). Estimated size: ${estimate === null ? 'calculating…' : `about ${fmtBytes(estimate)}`}.`}
              </p>
            </>
          )}
          {isLottie && (
            <p className="text-xs text-dim">
              Plays in Lottie players (tested with lottie-web). Effects, shadows, glow, 3D tilt and video can't be shown in Lottie; after the export, a list names what was left out.
            </p>
          )}
          {!isAscii && !isLottie && (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between text-xs font-medium text-dim">
              <span>Size</span>
              <span className="tabular-nums text-zinc-400">
                {w} × {h} px
              </span>
            </div>
            <PresetGrid label="Scale" value={String(scale)} options={scales.map((s) => ({ value: String(s), label: `${s}×` }))} onChange={(v) => update({ scale: Number(v) })} columns={4} />
          </div>
          )}
          {(fmt === 'png' || fmt === 'webp' || fmt === 'png-seq') && (
            <Switch
              switchSize="sm"
              checked={settings.transparent}
              onCheckedChange={(transparent) => update({ transparent })}
              label="Transparent background"
              labelClassName="text-sm text-zinc-300"
            />
          )}
          {fmt === 'webm' && (
            <>
              <Switch
                switchSize="sm"
                checked={settings.webmTransparent}
                onCheckedChange={(webmTransparent) => update({ webmTransparent })}
                label="Transparent background"
                labelClassName="text-sm text-zinc-300"
              />
              <p className="text-xs text-dim">VP9 with an alpha channel, and Opus audio when a video layer has sound. Chrome and Firefox play the transparency; for tools that can't, turn it off.</p>
            </>
          )}
          {fmt === 'png-seq' && (
            <p className="text-xs text-dim">
              {frameCount} PNGs, frame-00000.png onwards, in one .zip. No audio.
            </p>
          )}
          {(fmt === 'jpeg' || fmt === 'webp') && (
            <SliderField label="Quality" hint={`${Math.round(settings.quality * 100)}%`} min={0.5} max={1} step={0.01} value={settings.quality} onValueChange={(quality) => update({ quality })} />
          )}
          {fmt === 'gif' && (
            <>
              <SelectField
                label="Frame rate"
                value={String(settings.gifFps)}
                options={[10, 20, 25].map((f) => ({ value: String(f), label: `${f} fps` }))}
                onValueChange={(f) => update({ gifFps: Number(f) as ExportSettings['gifFps'] })}
              />
              <p className="text-xs text-dim">GIF has 256 colours and no partial transparency. Use MP4 for the best quality and smallest files.</p>
            </>
          )}
          {busy && <Progress value={Math.round((progress ?? 0) * 100)} max={100} label="Export progress" showValue size="sm" />}
          {message && (
            <p role="status" className="text-sm text-emerald-300">
              {message}
            </p>
          )}
          {result && (
            <p role="status" className="text-sm text-emerald-300">
              Saved {result.filename} · {result.width}×{result.height} · {fmtBytes(result.blob.size)} · {(result.ms / 1000).toFixed(1)}s
              {result.note && <span className="mt-1 block text-amber-300">{result.note}</span>}
              {result.omitted && result.omitted.length === 0 && <span className="mt-1 block">Everything in the scene is included.</span>}
            </p>
          )}
          {result?.omitted && result.omitted.length > 0 && (
            <div className="space-y-1">
              <h3 id="export-left-out" className="text-xs font-medium text-amber-300">
                Left out ({result.omitted.length})
              </h3>
              <ul role="list" aria-labelledby="export-left-out" tabIndex={0} className="max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-zinc-300">
                {result.omitted.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-300">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          {busy ? (
            <Button onClick={() => abort.current?.abort()}>
              <X size={14} /> Cancel
            </Button>
          ) : (
            <Button variant="primary" onClick={start}>
              <Download size={14} /> {isAscii ? (ascii.output === 'copy' ? 'Copy ASCII frame' : 'Export ASCII text') : `Export ${FORMATS.find((f) => f.value === fmt)!.label}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
