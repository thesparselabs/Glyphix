// Easing of the selected keyframes (the curve to each one's next key), for the timeline header and the inspector.
import { EasingButton } from '../EasingEditor';
import { useEditor } from '../store';
import { selectedKeysEasing, setSelectedKeysEasing, useKeySelection } from './keySelection';

export function KeyEasing({ side }: { side?: 'left' | 'top' }) {
  useKeySelection((s) => s.keys);
  useEditor((s) => s.doc);
  const info = selectedKeysEasing();
  const skipped = info?.skipped
    ? `${info.skipped === 1 ? 'A last keyframe has' : `${info.skipped} last keyframes have`} no next key, so ${info.skipped === 1 ? 'its' : 'their'} easing is not used.`
    : undefined;
  return (
    <span data-key-easing className="contents">
      <EasingButton
        label="Keyframe easing"
        value={info?.value ?? null}
        disabled={!info?.editable}
        note={skipped}
        side={side}
        onChange={(e, coalesceKey) => setSelectedKeysEasing(e, coalesceKey)}
      />
    </span>
  );
}
