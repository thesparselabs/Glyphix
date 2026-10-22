// Keyframe toggle + a wrapper that puts one next to any animatable control.
// Static values never subscribe to the playhead (no re-render while playing); only animated ones do.
import type { ReactNode } from 'react';
import { Diamond } from 'lucide-react';
import { addKey, keyAt, removeKey, sampleValue, setValueAt, snapToFrame, type Prop } from '@/doc';
import { useEditor } from './store';

type OnChange<V> = (p: Prop<V>, label: string) => void;

/** Diamond button: add / remove a key at the playhead. `time` is the playhead for animated props, null for static ones. */
export function KeyButton<V>({ prop, name, time, onChange }: { prop: Prop<V>; name: string; time: number | null; onChange: OnChange<V> }) {
  const eps = useEditor((s) => 0.5 / s.doc.comp.fps);
  const animated = 'track' in prop;
  const key = time === null ? null : keyAt(prop, time, eps);
  const toggle = () => {
    const st = useEditor.getState();
    const t = snapToFrame(time ?? st.time, st.doc.comp.fps);
    const at = keyAt(prop, t, eps);
    onChange(at ? removeKey(prop, t, eps) : addKey(prop, t, sampleValue(prop, t), eps), at ? 'Remove keyframe' : 'Add keyframe');
  };
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={!!key}
      aria-label={key ? `Remove ${name} keyframe at playhead` : `Add ${name} keyframe at playhead`}
      title={key ? 'Remove keyframe at playhead' : animated ? 'Add keyframe at playhead' : 'Animate: add a keyframe at the playhead'}
      className={`grid size-5 shrink-0 place-items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-accent ${animated ? 'text-amber-300' : 'text-zinc-500 hover:text-zinc-200'}`}
    >
      <Diamond size={11} fill={key ? 'currentColor' : 'none'} />
    </button>
  );
}

type PropControlProps<V> = {
  prop: Prop<V>;
  /** Accessible name stem, e.g. "text colour" -> "Add text colour keyframe at playhead". */
  name: string;
  /** Undo label for value edits. */
  label: string;
  onChange: OnChange<V>;
  /** Render the control: gets the value at the playhead and a setter that writes the key at the playhead (or the static value). */
  children: (value: V, set: (v: V) => void) => ReactNode;
  align?: 'start' | 'end';
};

export function PropControl<V>(props: PropControlProps<V>) {
  return 'track' in props.prop ? <AnimatedPropControl {...props} /> : <PropControlBody {...props} time={null} />;
}

function AnimatedPropControl<V>(props: PropControlProps<V>) {
  const time = useEditor((s) => s.time);
  return <PropControlBody {...props} time={time} />;
}

function PropControlBody<V>({ prop, name, label, onChange, children, align = 'end', time }: PropControlProps<V> & { time: number | null }) {
  const value = sampleValue(prop, time ?? 0);
  const set = (v: V) => {
    const st = useEditor.getState();
    onChange(setValueAt(prop, snapToFrame(st.time, st.doc.comp.fps), v, 0.5 / st.doc.comp.fps), label);
  };
  return (
    <div className={`flex gap-1.5 ${align === 'start' ? 'items-start' : 'items-end'}`}>
      <div className="min-w-0 flex-1">{children(value, set)}</div>
      <div className={align === 'end' ? 'pb-1.5' : 'pt-0.5'}>
        <KeyButton prop={prop} name={name} time={time} onChange={onChange} />
      </div>
    </div>
  );
}
