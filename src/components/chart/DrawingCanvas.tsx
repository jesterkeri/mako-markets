// ----------------------------------------------------------------------------
// src/components/chart/DrawingCanvas.tsx
//
// HTML5 canvas overlay that paints user-drawn annotations on top of
// the lightweight-charts surface. Ported from krait
// `apps/web/src/components/chart/DrawingCanvas.tsx` — the canvas math
// is asset-agnostic and works as-is once we feed it the chart + series
// refs from ChartInner.
//
// Mako tweaks vs krait original:
//   - Text background swapped from dark-glass to ink so labels stay
//     legible against cream paper
//   - Price labels formatted with 2dp default (most mako assets are
//     in [1, 10000] range); FX 5dp pipettes are handled in the
//     dedicated label on horizontal-line / horizontal-ray
// ----------------------------------------------------------------------------

'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import type { Drawing, DrawingTool, DrawingPoint } from '@/types/drawing';
import { FIBONACCI_LEVELS } from '@/types/drawing';

interface Props {
  chart: IChartApi | null;
  series: ISeriesApi<'Candlestick'> | null;
  drawings: Drawing[];
  activeTool: DrawingTool;
  activeColor: string;
  selectedId: string | null;
  onAddDrawing: (drawing: Omit<Drawing, 'id'>) => string;
  onUpdateDrawing?: (id: string, updates: Partial<Drawing>) => void;
  onRemoveDrawing: (id: string) => void;
  onSelectDrawing: (id: string | null) => void;
}

function mouseToPoint(
  e: MouseEvent,
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  container: HTMLElement,
): DrawingPoint | null {
  const rect = container.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const time = chart.timeScale().coordinateToTime(x);
  const price = series.coordinateToPrice(y);
  if (time === null || price === null) return null;
  return { time: time as number, price };
}

function pointToSegmentDist(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function DrawingCanvas({
  chart, series, drawings, activeTool, activeColor, selectedId,
  onAddDrawing, onUpdateDrawing, onRemoveDrawing, onSelectDrawing,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pendingPoint, setPendingPoint] = useState<DrawingPoint | null>(null);
  const [hoverPoint, setHoverPoint] = useState<DrawingPoint | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const dragState = useRef<{
    mode: 'move' | 'resize';
    drawingId: string;
    pointIndex: number;
    startMouse: DrawingPoint;
    originalPoints: DrawingPoint[];
  } | null>(null);

  const draw = useCallback(() => {
    if (!chart || !series || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const container = canvas.parentElement;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const ts = chart.timeScale();

    const drawHandle = (hx: number, hy: number) => {
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(hx, hy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    for (const d of drawings) {
      const isSelected = d.id === selectedId;
      ctx.strokeStyle = d.color;
      ctx.fillStyle = d.color;
      ctx.lineWidth = isSelected ? d.lineWidth + 1 : d.lineWidth;

      if (d.lineStyle === 'dashed') ctx.setLineDash([6, 4]);
      else if (d.lineStyle === 'dotted') ctx.setLineDash([2, 3]);
      else ctx.setLineDash([]);

      switch (d.type) {
        case 'horizontal-line': {
          const y = series.priceToCoordinate(d.points[0]!.price);
          if (y === null) break;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(rect.width, y);
          ctx.stroke();
          ctx.font = '11px Inter, sans-serif';
          ctx.setLineDash([]);
          ctx.fillText(d.points[0]!.price.toFixed(5), 4, y - 4);
          if (isSelected) {
            drawHandle(rect.width / 4, y);
            drawHandle(rect.width * 3 / 4, y);
          }
          break;
        }

        case 'horizontal-ray': {
          const y = series.priceToCoordinate(d.points[0]!.price);
          const x = ts.timeToCoordinate(d.points[0]!.time as Time);
          if (y === null || x === null) break;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(rect.width, y);
          ctx.stroke();
          ctx.font = '11px Inter, sans-serif';
          ctx.setLineDash([]);
          ctx.fillText(d.points[0]!.price.toFixed(5), x + 4, y - 4);
          if (isSelected) drawHandle(x, y);
          break;
        }

        case 'trend-line': {
          if (d.points.length < 2) break;
          const x1 = ts.timeToCoordinate(d.points[0]!.time as Time);
          const y1 = series.priceToCoordinate(d.points[0]!.price);
          const x2 = ts.timeToCoordinate(d.points[1]!.time as Time);
          const y2 = series.priceToCoordinate(d.points[1]!.price);
          if (x1 === null || y1 === null || x2 === null || y2 === null) break;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          if (isSelected) { drawHandle(x1, y1); drawHandle(x2, y2); }
          break;
        }

        case 'rectangle': {
          if (d.points.length < 2) break;
          const rx1 = ts.timeToCoordinate(d.points[0]!.time as Time);
          const ry1 = series.priceToCoordinate(d.points[0]!.price);
          const rx2 = ts.timeToCoordinate(d.points[1]!.time as Time);
          const ry2 = series.priceToCoordinate(d.points[1]!.price);
          if (rx1 === null || ry1 === null || rx2 === null || ry2 === null) break;
          const rLeft = Math.min(rx1, rx2);
          const rTop = Math.min(ry1, ry2);
          const rW = Math.abs(rx2 - rx1);
          const rH = Math.abs(ry2 - ry1);
          ctx.globalAlpha = 0.15;
          ctx.fillRect(rLeft, rTop, rW, rH);
          ctx.globalAlpha = 1;
          ctx.strokeRect(rLeft, rTop, rW, rH);
          if (isSelected) {
            drawHandle(rx1, ry1);
            drawHandle(rx2, ry2);
            drawHandle(rx1, ry2);
            drawHandle(rx2, ry1);
          }
          break;
        }

        case 'fibonacci': {
          if (d.points.length < 2) break;
          const fx1 = ts.timeToCoordinate(d.points[0]!.time as Time);
          const fx2 = ts.timeToCoordinate(d.points[1]!.time as Time);
          if (fx1 === null || fx2 === null) break;
          const highPrice = Math.max(d.points[0]!.price, d.points[1]!.price);
          const lowPrice = Math.min(d.points[0]!.price, d.points[1]!.price);
          const priceRange = highPrice - lowPrice;
          const left = Math.min(fx1, fx2);
          const width = Math.abs(fx2 - fx1);

          for (const fib of FIBONACCI_LEVELS) {
            const price = highPrice - priceRange * fib.level;
            const y = series.priceToCoordinate(price);
            if (y === null) continue;
            if (fib.level === 0.618) {
              const oteTop = series.priceToCoordinate(highPrice - priceRange * 0.618);
              const oteBot = series.priceToCoordinate(highPrice - priceRange * 0.786);
              if (oteTop !== null && oteBot !== null) {
                ctx.fillStyle = 'rgba(41, 98, 255, 0.08)';
                ctx.fillRect(left, Math.min(oteTop, oteBot), width || rect.width, Math.abs(oteBot - oteTop));
              }
            }
            ctx.strokeStyle = d.color;
            ctx.globalAlpha = fib.level === 0.5 ? 0.5 : 0.7;
            ctx.setLineDash(fib.level === 0.5 ? [4, 4] : []);
            ctx.beginPath();
            ctx.moveTo(left, y);
            ctx.lineTo(left + (width || rect.width), y);
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.fillStyle = d.color;
            ctx.font = '10px Inter, sans-serif';
            ctx.fillText(`${fib.label} (${price.toFixed(5)})`, left + 4, y - 3);
          }
          ctx.setLineDash([]);
          if (isSelected) {
            const fy1 = series.priceToCoordinate(d.points[0]!.price);
            const fy2 = series.priceToCoordinate(d.points[1]!.price);
            if (fy1 !== null) drawHandle(fx1, fy1);
            if (fy2 !== null) drawHandle(fx2, fy2);
          }
          break;
        }

        case 'text': {
          if (d.points.length < 1 || !d.text) break;
          const tx = ts.timeToCoordinate(d.points[0]!.time as Time);
          const ty = series.priceToCoordinate(d.points[0]!.price);
          if (tx === null || ty === null) break;
          ctx.font = '12px Inter, sans-serif';
          const metrics = ctx.measureText(d.text);
          ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
          ctx.fillRect(tx - 2, ty - 14, metrics.width + 8, 18);
          ctx.fillStyle = d.color;
          ctx.fillText(d.text, tx + 2, ty);
          if (isSelected) drawHandle(tx, ty);
          break;
        }

        case 'measure': {
          if (d.points.length < 2) break;
          const mx1 = ts.timeToCoordinate(d.points[0]!.time as Time);
          const my1 = series.priceToCoordinate(d.points[0]!.price);
          const mx2 = ts.timeToCoordinate(d.points[1]!.time as Time);
          const my2 = series.priceToCoordinate(d.points[1]!.price);
          if (mx1 === null || my1 === null || mx2 === null || my2 === null) break;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(mx1, my1);
          ctx.lineTo(mx2, my2);
          ctx.stroke();
          ctx.setLineDash([]);
          const priceDiff = d.points[1]!.price - d.points[0]!.price;
          const pct = (priceDiff / d.points[0]!.price * 100).toFixed(2);
          const label = `${priceDiff >= 0 ? '+' : ''}${priceDiff.toFixed(5)} (${pct}%)`;
          const midX = (mx1 + mx2) / 2;
          const midY = (my1 + my2) / 2;
          ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
          const lm = ctx.measureText(label);
          ctx.fillRect(midX - 4, midY - 14, lm.width + 12, 18);
          ctx.fillStyle = priceDiff >= 0 ? '#000000' : '#D94A3D';
          ctx.font = '11px Inter, sans-serif';
          ctx.fillText(label, midX + 2, midY);
          if (isSelected) { drawHandle(mx1, my1); drawHandle(mx2, my2); }
          break;
        }
      }
    }

    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    if (pendingPoint && hoverPoint && activeTool !== 'cursor' && activeTool !== 'eraser') {
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.globalAlpha = 0.6;
      const px1 = ts.timeToCoordinate(pendingPoint.time as Time);
      const py1 = series.priceToCoordinate(pendingPoint.price);
      const px2 = ts.timeToCoordinate(hoverPoint.time as Time);
      const py2 = series.priceToCoordinate(hoverPoint.price);
      if (px1 !== null && py1 !== null && px2 !== null && py2 !== null) {
        if (activeTool === 'trend-line' || activeTool === 'measure') {
          ctx.beginPath(); ctx.moveTo(px1, py1); ctx.lineTo(px2, py2); ctx.stroke();
        } else if (activeTool === 'rectangle') {
          ctx.strokeRect(Math.min(px1, px2), Math.min(py1, py2), Math.abs(px2 - px1), Math.abs(py2 - py1));
        } else if (activeTool === 'fibonacci') {
          ctx.beginPath(); ctx.moveTo(px1, py1); ctx.lineTo(px2, py2); ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }, [chart, series, drawings, selectedId, pendingPoint, hoverPoint, activeTool, activeColor]);

  useEffect(() => {
    if (!chart) return;
    draw();
    const handler = () => draw();
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    const ro = new ResizeObserver(draw);
    if (canvasRef.current?.parentElement) ro.observe(canvasRef.current.parentElement);
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
      ro.disconnect();
    };
  }, [chart, draw]);

  useEffect(() => { draw(); }, [draw]);

  const findNearestDrawing = useCallback((mx: number, my: number): string | null => {
    if (!chart || !series) return null;
    let closest: { id: string; dist: number } | null = null;
    for (const d of drawings) {
      let dist = Infinity;
      if (d.type === 'horizontal-line' || d.type === 'horizontal-ray') {
        const y = series.priceToCoordinate(d.points[0]!.price);
        if (y !== null) dist = Math.abs(my - y);
      } else if (d.type === 'text') {
        const x = chart.timeScale().timeToCoordinate(d.points[0]!.time as Time);
        const y = series.priceToCoordinate(d.points[0]!.price);
        if (x !== null && y !== null) dist = Math.hypot(mx - x, my - y);
      } else if (d.points.length >= 2) {
        const x1 = chart.timeScale().timeToCoordinate(d.points[0]!.time as Time);
        const y1 = series.priceToCoordinate(d.points[0]!.price);
        const x2 = chart.timeScale().timeToCoordinate(d.points[1]!.time as Time);
        const y2 = series.priceToCoordinate(d.points[1]!.price);
        if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
          if (d.type === 'rectangle') {
            const l = Math.min(x1, x2), r = Math.max(x1, x2), t = Math.min(y1, y2), b = Math.max(y1, y2);
            dist = Math.min(
              pointToSegmentDist(mx, my, l, t, r, t),
              pointToSegmentDist(mx, my, r, t, r, b),
              pointToSegmentDist(mx, my, r, b, l, b),
              pointToSegmentDist(mx, my, l, b, l, t),
            );
            if (mx >= l && mx <= r && my >= t && my <= b) dist = Math.min(dist, 5);
          } else {
            dist = pointToSegmentDist(mx, my, x1, y1, x2, y2);
          }
        }
      }
      if (dist < 15 && (!closest || dist < closest.dist)) {
        closest = { id: d.id, dist };
      }
    }
    return closest?.id ?? null;
  }, [chart, series, drawings]);

  const findNearestHandle = useCallback((mx: number, my: number): number => {
    if (!chart || !series || !selectedId) return -1;
    const d = drawings.find((dr) => dr.id === selectedId);
    if (!d || d.locked) return -1;

    for (let pi = 0; pi < d.points.length; pi++) {
      const px = chart.timeScale().timeToCoordinate(d.points[pi]!.time as Time);
      const py = series.priceToCoordinate(d.points[pi]!.price);
      if (px !== null && py !== null && Math.hypot(mx - px, my - py) < 10) return pi;
    }

    if (d.type === 'rectangle' && d.points.length >= 2) {
      const x1 = chart.timeScale().timeToCoordinate(d.points[0]!.time as Time);
      const y1 = series.priceToCoordinate(d.points[0]!.price);
      const x2 = chart.timeScale().timeToCoordinate(d.points[1]!.time as Time);
      const y2 = series.priceToCoordinate(d.points[1]!.price);
      if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
        if (Math.hypot(mx - x1, my - y2) < 10) return 10;
        if (Math.hypot(mx - x2, my - y1) < 10) return 11;
      }
    }

    return -1;
  }, [chart, series, selectedId, drawings]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (!chart || !series || !canvasRef.current) return;
    const container = canvasRef.current.parentElement!;
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (activeTool === 'cursor') {
      if (!selectedId || !onUpdateDrawing) return;
      const selDrawing = drawings.find((d) => d.id === selectedId);
      if (!selDrawing || selDrawing.locked) return;

      const handleIdx = findNearestHandle(mx, my);
      if (handleIdx >= 0) {
        const point = mouseToPoint(e.nativeEvent, chart, series, container);
        if (point) {
          dragState.current = {
            mode: 'resize', drawingId: selectedId, pointIndex: handleIdx,
            startMouse: point, originalPoints: selDrawing.points.map((p) => ({ ...p })),
          };
          setIsDragging(true);
          e.stopPropagation();
          e.preventDefault();
        }
        return;
      }

      const nearId = findNearestDrawing(mx, my);
      if (nearId === selectedId) {
        const point = mouseToPoint(e.nativeEvent, chart, series, container);
        if (point) {
          dragState.current = {
            mode: 'move', drawingId: selectedId, pointIndex: -1,
            startMouse: point, originalPoints: selDrawing.points.map((p) => ({ ...p })),
          };
          setIsDragging(true);
          e.stopPropagation();
        }
      }
      return;
    }

    const point = mouseToPoint(e.nativeEvent, chart, series, container);
    if (!point) return;

    if (activeTool === 'eraser') {
      const nearId = findNearestDrawing(mx, my);
      if (nearId) onRemoveDrawing(nearId);
      return;
    }

    if (activeTool === 'horizontal-line' || activeTool === 'horizontal-ray') {
      onAddDrawing({ type: activeTool, points: [point], color: activeColor, lineWidth: 1, lineStyle: 'solid', locked: false });
      return;
    }

    if (activeTool === 'text') {
      const text = prompt('Enter text:');
      if (text) onAddDrawing({ type: 'text', points: [point], color: activeColor, lineWidth: 1, lineStyle: 'solid', text, locked: false });
      return;
    }

    if (!pendingPoint) {
      setPendingPoint(point);
    } else {
      onAddDrawing({
        type: activeTool as Drawing['type'],
        points: [pendingPoint, point],
        color: activeColor, lineWidth: 1, lineStyle: 'solid', locked: false,
      });
      setPendingPoint(null);
      setHoverPoint(null);
    }
  }, [chart, series, activeTool, activeColor, pendingPoint, drawings, selectedId, findNearestDrawing, findNearestHandle, onAddDrawing, onUpdateDrawing, onRemoveDrawing]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!chart || !series || !canvasRef.current) return;
    const container = canvasRef.current.parentElement!;

    if (dragState.current && onUpdateDrawing) {
      const point = mouseToPoint(e.nativeEvent, chart, series, container);
      if (!point) return;
      const ds = dragState.current;
      const dt = point.time - ds.startMouse.time;
      const dp = point.price - ds.startMouse.price;

      if (ds.mode === 'move') {
        onUpdateDrawing(ds.drawingId, {
          points: ds.originalPoints.map((p) => ({ time: p.time + dt, price: p.price + dp })),
        });
      } else if (ds.mode === 'resize') {
        const pi = ds.pointIndex;
        if (pi === 10) {
          onUpdateDrawing(ds.drawingId, {
            points: [
              { time: ds.originalPoints[0]!.time + dt, price: ds.originalPoints[0]!.price },
              { time: ds.originalPoints[1]!.time, price: ds.originalPoints[1]!.price + dp },
            ],
          });
        } else if (pi === 11) {
          onUpdateDrawing(ds.drawingId, {
            points: [
              { time: ds.originalPoints[0]!.time, price: ds.originalPoints[0]!.price + dp },
              { time: ds.originalPoints[1]!.time + dt, price: ds.originalPoints[1]!.price },
            ],
          });
        } else {
          onUpdateDrawing(ds.drawingId, {
            points: ds.originalPoints.map((p, i) =>
              i === pi ? { time: p.time + dt, price: p.price + dp } : { ...p },
            ),
          });
        }
      }
      e.preventDefault();
      return;
    }

    if (!pendingPoint) return;
    const point = mouseToPoint(e.nativeEvent, chart, series, container);
    if (point) setHoverPoint(point);
  }, [chart, series, pendingPoint, onUpdateDrawing]);

  const handleMouseUp = useCallback(() => {
    dragState.current = null;
    setIsDragging(false);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPendingPoint(null);
        setHoverPoint(null);
        dragState.current = null;
        setIsDragging(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (activeTool !== 'cursor' || drawings.length === 0) return;
    const container = canvasRef.current?.parentElement;
    if (!container || !chart || !series) return;

    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.closest('[data-drawing-editor]') ||
        target.closest('[data-drawing-toolbar]')
      ) return;
      if (!target.closest('canvas') && target !== container) return;

      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const nearId = findNearestDrawing(mx, my);

      if (nearId) {
        onSelectDrawing(nearId);
      } else if (selectedId) {
        onSelectDrawing(null);
      }
    };

    container.addEventListener('click', handler);
    return () => container.removeEventListener('click', handler);
  }, [activeTool, drawings, chart, series, selectedId, findNearestDrawing, onSelectDrawing]);

  const isDrawingTool = activeTool !== 'cursor';
  const needsPointer = isDrawingTool || isDragging || (activeTool === 'cursor' && selectedId !== null);

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      style={{
        position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
        pointerEvents: needsPointer ? 'auto' : 'none',
        zIndex: isDrawingTool ? 5 : 2,
        cursor: isDragging
          ? 'grabbing'
          : activeTool === 'eraser'
            ? 'crosshair'
            : activeTool === 'cursor'
              ? 'default'
              : 'crosshair',
      }}
    />
  );
}
