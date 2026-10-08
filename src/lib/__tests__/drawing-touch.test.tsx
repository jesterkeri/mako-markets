// @vitest-environment jsdom
// The drawing tools with a finger (Joshua, 2026-10-08: "the drawing doesn't allow dragging with fingers"): pointer
// events drive them, a two-point tool completes on press-drag-release with a finger, a mouse keeps click-click, and
// while a tool is active the canvas claims the gesture from the chart.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

import { DrawingCanvas } from '@/components/chart/DrawingCanvas';

beforeAll(() => {
  // jsdom draws nothing; the canvas only needs a 2D context to call into.
  HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, { get: () => () => {} })) as never;
  HTMLCanvasElement.prototype.setPointerCapture = () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});
afterEach(() => cleanup());

// Screen x is the time and screen y the price, one to one.
const chart = {
  timeScale: () => ({ coordinateToTime: (x: number) => x, timeToCoordinate: (t: number) => t, subscribeVisibleLogicalRangeChange: () => {}, unsubscribeVisibleLogicalRangeChange: () => {} }),
  subscribeCrosshairMove: () => {},
  unsubscribeCrosshairMove: () => {},
} as never;
const series = { coordinateToPrice: (y: number) => y, priceToCoordinate: (p: number) => p } as never;

function setup(tool: 'trend-line' | 'cursor') {
  const onAddDrawing = vi.fn((_d: unknown) => 'd1');
  const { container } = render(
    <div style={{ position: 'relative', width: 400, height: 300 }}>
      <DrawingCanvas chart={chart} series={series} drawings={[]} activeTool={tool} activeColor="#fff" selectedId={null} onAddDrawing={onAddDrawing} onRemoveDrawing={() => {}} onSelectDrawing={() => {}} />
    </div>,
  );
  const canvas = container.querySelector('canvas') as HTMLCanvasElement;
  (canvas.parentElement as HTMLElement).getBoundingClientRect = () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return { canvas, onAddDrawing };
}

const at = (x: number, y: number, pointerType: string) => ({ clientX: x, clientY: y, pointerId: 1, pointerType, buttons: 1 });

describe('drawing with a finger', () => {
  it('a trend line is drawn by pressing at one point and lifting at another', () => {
    const { canvas, onAddDrawing } = setup('trend-line');
    fireEvent.pointerDown(canvas, at(20, 40, 'touch'));
    fireEvent.pointerMove(canvas, at(120, 90, 'touch'));
    fireEvent.pointerUp(canvas, at(200, 140, 'touch'));
    expect(onAddDrawing).toHaveBeenCalledTimes(1);
    expect(onAddDrawing.mock.calls[0][0]).toMatchObject({ type: 'trend-line', points: [{ time: 20, price: 40 }, { time: 200, price: 140 }] });
  });

  it('a finger that barely moves does not finish the line: tap, then tap the second point', () => {
    const { canvas, onAddDrawing } = setup('trend-line');
    fireEvent.pointerDown(canvas, at(20, 40, 'touch'));
    fireEvent.pointerUp(canvas, at(24, 42, 'touch'));
    expect(onAddDrawing).not.toHaveBeenCalled();
    fireEvent.pointerDown(canvas, at(200, 140, 'touch'));
    fireEvent.pointerUp(canvas, at(200, 140, 'touch'));
    expect(onAddDrawing).toHaveBeenCalledTimes(1);
  });

  it('a mouse keeps click, then click (a press-drag does not end the line)', () => {
    const { canvas, onAddDrawing } = setup('trend-line');
    fireEvent.pointerDown(canvas, at(20, 40, 'mouse'));
    fireEvent.pointerUp(canvas, at(200, 140, 'mouse'));
    expect(onAddDrawing).not.toHaveBeenCalled();
    fireEvent.pointerDown(canvas, at(200, 140, 'mouse'));
    expect(onAddDrawing).toHaveBeenCalledTimes(1);
  });

  it('while a tool is active the canvas takes the touch from the chart; with the cursor it lets the chart have it', () => {
    expect(setup('trend-line').canvas.style.touchAction).toBe('none');
    cleanup();
    expect(setup('cursor').canvas.style.touchAction).toBe('');
  });
});
