import { Easings } from './easing';
import { NO_MOTION } from './motion';
import { FULL_CROP, NO_FRAME, NO_TILT, REST_POSE, SCHEMA_VERSION, type Doc, type TextLayer } from './types';

export const DEMO_SCREENSHOT_ASSET = 'demo-screenshot';

/** The Milestone A document: gradient background, a screenshot, and an animated headline. */
export function createDemoDoc(headline = 'Ship visuals that move'): Doc {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: 'demo',
    name: 'Untitled',
    comp: {
      width: 1920,
      height: 1080,
      duration: 5,
      fps: 30,
      layers: [
        {
          id: 'bg',
          name: 'Background',
          type: 'background',
          visible: true,
          timing: { in: 0, out: null },
          locked: true,
          opacity: { static: 1 },
          effects: [],
          fill: {
            kind: 'linear',
            angle: { static: 135 },
            stops: [
              { offset: { static: 0 }, color: { static: [0.35, 0.2, 0.95, 1] } },
              { offset: { static: 0.55 }, color: { static: [0.85, 0.25, 0.65, 1] } },
              { offset: { static: 1 }, color: { static: [1, 0.6, 0.3, 1] } },
            ],
          },
        },
        {
          id: 'shot',
          name: 'Screenshot',
          type: 'image',
          visible: true,
          timing: { in: 0, out: null },
          locked: false,
          assetId: DEMO_SCREENSHOT_ASSET,
          video: null,
          crop: FULL_CROP,
          width: 1280,
          height: 760,
          radius: { static: 18 },
          shadow: { blur: { static: 60 }, offsetX: { static: 0 }, offsetY: { static: 30 }, color: { static: [0.05, 0.02, 0.15, 0.55] } },
          border: null,
          frame: NO_FRAME,
          tilt: NO_TILT,
          motion: NO_MOTION,
          opacity: { track: { keys: [{ t: 0, v: 0, out: Easings.easeOutCubic }, { t: 0.8, v: 1, out: Easings.linear }] } },
          effects: [],
          transform: {
            x: { static: 960 },
            y: { track: { keys: [{ t: 0, v: 700, out: Easings.easeOutCubic }, { t: 1, v: 640, out: Easings.linear }] } },
            scale: { track: { keys: [{ t: 0, v: 0.94, out: Easings.easeOutCubic }, { t: 1, v: 1, out: Easings.linear }] } },
            rotation: { static: 0 },
          },
        },
        {
          id: 'headline',
          name: 'Headline',
          type: 'text',
          visible: true,
          timing: { in: 0, out: null },
          locked: false,
          text: { static: headline },
          fontId: 'inter',
          weight: 400,
          fontSize: 96,
          lineHeight: 1.15,
          color: { static: [1, 1, 1, 1] },
          gradient: null,
          outline: null,
          shadow: null,
          align: 'center',
          tracking: -0.02,
          opacity: { static: 1 },
          effects: [],
          glow: { track: { keys: [{ t: 0.4, v: 0, out: Easings.easeOutCubic }, { t: 1.6, v: 0.8, out: Easings.easeInOutCubic }, { t: 3, v: 0.25, out: Easings.linear }] } },
          glowColor: { static: [1, 0.85, 1, 1] },
          transform: { x: { static: 960 }, y: { static: 150 }, scale: { static: 1 }, rotation: { static: 0 } },
          motion: NO_MOTION,
          animator: {
            unit: 'glyph',
            order: 'forward',
            start: 0.3,
            duration: 0.7,
            stagger: 0.04,
            falloff: Easings.linear,
            seed: 7,
            easing: Easings.easeOutBack,
            pose: { ...REST_POSE, offsetY: 60, scaleX: 0.4, scaleY: 0.4, rotation: -12, opacity: 0 },
          },
        },
      ],
    },
  };
}

/** A fresh project: gradient background and a headline that rises in. */
export function createBlankDoc(id: string): Doc {
  const demo = createDemoDoc('Your headline');
  const [bg, , headline] = demo.comp.layers as [Doc['comp']['layers'][number], unknown, TextLayer];
  return {
    ...demo,
    id,
    name: 'Untitled',
    comp: {
      ...demo.comp,
      layers: [
        bg,
        {
          ...headline,
          animator: null,
          glow: { static: 0.3 },
          transform: { ...headline.transform, y: { static: 540 } },
          motion: { enter: { preset: 'rise', start: 0.2, duration: 1, easing: Easings.easeOutBack }, exit: null, loop: null },
        },
      ],
    },
  };
}
