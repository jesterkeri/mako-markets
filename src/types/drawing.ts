// ----------------------------------------------------------------------------
// src/types/drawing.ts
//
// Chart drawing-tool types. Ported verbatim from krait
// `apps/web/src/types/drawing.ts`. The drawing layer reuses krait's
// implementation; types are kept identical so the canvas logic
// transplants cleanly.
// ----------------------------------------------------------------------------

export type DrawingTool =
  | 'cursor'
  | 'horizontal-line'
  | 'trend-line'
  | 'horizontal-ray'
  | 'rectangle'
  | 'fibonacci'
  | 'text'
  | 'measure'
  | 'eraser';

export interface DrawingPoint {
  /** Unix seconds (lightweight-charts time). */
  time: number;
  price: number;
}

export interface Drawing {
  id: string;
  type: Exclude<DrawingTool, 'cursor' | 'eraser'>;
  points: DrawingPoint[];
  color: string;
  lineWidth: number;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  text?: string;
  locked: boolean;
}

/**
 * Palette offered in the color picker. First entry is the default.
 * Tweaked slightly from krait to lead with mako's signal yellow +
 * mako-red, since the chart canvas sits on cream paper bg.
 */
export const DRAWING_COLORS = [
  '#FACC15', // signal (default — high contrast on cream)
  '#D94A3D', // mako-red
  '#000000', // ink
  '#2962ff', // blue
  '#26a69a', // teal
  '#ab47bc', // purple
  '#ff9800', // orange
  '#787b86', // gray
];

export const DEFAULT_DRAWING_COLOR = DRAWING_COLORS[0];

export const FIBONACCI_LEVELS = [
  { level: 0,     label: '0' },
  { level: 0.236, label: '0.236' },
  { level: 0.382, label: '0.382' },
  { level: 0.5,   label: '0.5' },
  { level: 0.618, label: '0.618' },
  { level: 0.786, label: '0.786' },
  { level: 1,     label: '1' },
];
