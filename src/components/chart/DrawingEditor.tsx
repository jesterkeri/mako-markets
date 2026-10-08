// ----------------------------------------------------------------------------
// src/components/chart/DrawingEditor.tsx
//
// Popover for editing the currently-selected drawing (color, line
// width, line style, lock, delete). Dark (ink) surface to match the
// drawing toolbar — both live above the chart and read as a unified
// tool group.
// ----------------------------------------------------------------------------

'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { Drawing } from '@/types/drawing';
import { DRAWING_COLORS } from '@/types/drawing';

interface Props {
  drawing: Drawing;
  position: { x: number; y: number };
  onUpdate: (id: string, updates: Partial<Drawing>) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

function IconTrash() { return <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 5h14M7 5V4a1 1 0 011-1h4a1 1 0 011 1v1M8 9v5M12 9v5" /><path d="M4 5l1 12a1 1 0 001 1h8a1 1 0 001-1l1-12" /></svg>; }
function IconLock() { return <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="9" width="12" height="9" rx="1" /><path d="M7 9V6a3 3 0 016 0v3" /></svg>; }
function IconUnlock() { return <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="9" width="12" height="9" rx="1" /><path d="M7 9V6a3 3 0 016 0" /></svg>; }
function IconGrip() { return <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" opacity="0.55"><circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/></svg>; }
function IconClose() { return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square"><path d="M3 3l10 10M13 3L3 13" /></svg>; }

const LINE_WIDTHS = [1, 2, 3];
const LINE_STYLES: { value: Drawing['lineStyle']; dash: string }[] = [
  { value: 'solid',  dash: '' },
  { value: 'dashed', dash: '4 3' },
  { value: 'dotted', dash: '2 2' },
];

export function DrawingEditor({ drawing, position, onUpdate, onDelete, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(position);
  const dragging = useRef(false);
  const startClient = useRef({ x: 0, y: 0 });
  const startPos = useRef({ x: 0, y: 0 });

  const onDragStart = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    startClient.current = { x: e.clientX, y: e.clientY };
    startPos.current = { x: pos.x, y: pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - startClient.current.x;
      const dy = e.clientY - startClient.current.y;
      setPos({ x: startPos.current.x + dx, y: startPos.current.y + dy });
    };
    const up = () => { dragging.current = false; };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    return () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
    };
  }, []);

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const timer = setTimeout(() => document.addEventListener('pointerdown', handler), 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', handler);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      data-drawing-editor
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute z-40 flex flex-col gap-2.5 p-3 bg-ink border-2 border-ink rounded-xl shadow-brutal w-[224px] text-paper"
      style={{ top: pos.y, left: pos.x }}
    >
      {/* Drag header */}
      <div
        onPointerDown={onDragStart}
        className="flex justify-between items-center cursor-grab select-none"
        style={{ touchAction: 'none' }}
      >
        <div className="flex items-center gap-1.5 text-paper">
          <IconGrip />
          <span className="mako-label text-[10px] tracking-widest text-paper/70 uppercase">
            {drawing.type.replace('-', ' ')}
          </span>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="text-paper/60 hover:text-paper p-0.5 leading-none"
        >
          <IconClose />
        </button>
      </div>

      {/* Color */}
      <div>
        <div className="mako-label text-[9px] text-paper/60 tracking-widest mb-2">COLOR</div>
        <div className="grid grid-cols-8 gap-1.5 justify-items-center">
          {DRAWING_COLORS.map((c) => {
            const active = drawing.color === c;
            return (
              <button
                key={c}
                onClick={() => onUpdate(drawing.id, { color: c })}
                className="w-5 h-5 rounded-full p-0 cursor-pointer transition-shadow"
                style={{
                  background: c,
                  /* Same paper outline trick as the toolbar picker
                     so the ink swatch stays visible on ink bg. */
                  boxShadow: active
                    ? '0 0 0 2px #EBE5D9'
                    : '0 0 0 1px rgba(235,229,217,0.35)',
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.boxShadow = '0 0 0 2px rgba(235,229,217,0.55)';
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.boxShadow = '0 0 0 1px rgba(235,229,217,0.35)';
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Width */}
      <div>
        <div className="mako-label text-[9px] text-paper/60 tracking-widest mb-1.5">WIDTH</div>
        <div className="flex gap-1.5">
          {LINE_WIDTHS.map((w) => (
            <button
              key={w}
              onClick={() => onUpdate(drawing.id, { lineWidth: w })}
              className={`w-8 h-7 flex items-center justify-center border-2 rounded-md cursor-pointer transition-colors ${
                drawing.lineWidth === w
                  ? 'bg-paper border-paper'
                  : 'bg-transparent border-paper/30 hover:border-paper/70'
              }`}
            >
              <div
                className="w-4 rounded-sm"
                style={{
                  height: w,
                  background: drawing.lineWidth === w ? 'var(--mako-ink)' : '#EBE5D9',
                }}
              />
            </button>
          ))}
        </div>
      </div>

      {/* Style */}
      <div>
        <div className="mako-label text-[9px] text-paper/60 tracking-widest mb-1.5">STYLE</div>
        <div className="flex gap-1.5">
          {LINE_STYLES.map((s) => {
            const active = drawing.lineStyle === s.value;
            return (
              <button
                key={s.value}
                onClick={() => onUpdate(drawing.id, { lineStyle: s.value })}
                className={`flex-1 h-7 flex items-center justify-center border-2 rounded-md cursor-pointer transition-colors ${
                  active
                    ? 'bg-paper border-paper'
                    : 'bg-transparent border-paper/30 hover:border-paper/70'
                }`}
              >
                <svg width="26" height="2" viewBox="0 0 26 2">
                  <line
                    x1="0" y1="1" x2="26" y2="1"
                    stroke={active ? '#000000' : '#EBE5D9'}
                    strokeWidth="1.5"
                    strokeDasharray={s.dash}
                  />
                </svg>
              </button>
            );
          })}
        </div>
      </div>

      <div className="h-px bg-paper/15" />

      {/* Actions */}
      <div className="flex gap-1.5">
        <button
          onClick={() => onUpdate(drawing.id, { locked: !drawing.locked })}
          className={`flex-1 h-7 flex items-center justify-center gap-1 border-2 rounded-md mako-label text-[9px] cursor-pointer transition-colors ${
            drawing.locked
              ? 'bg-signal text-ink border-signal'
              : 'bg-transparent text-paper border-paper/40 hover:border-paper'
          }`}
        >
          {drawing.locked ? <IconLock /> : <IconUnlock />}
          {drawing.locked ? 'LOCKED' : 'LOCK'}
        </button>
        <button
          onClick={() => { onDelete(drawing.id); onClose(); }}
          className="flex-1 h-7 flex items-center justify-center gap-1 border-2 border-mako-red rounded-md mako-label text-[9px] cursor-pointer bg-mako-red/20 text-mako-red hover:bg-mako-red/30"
        >
          <IconTrash /> DELETE
        </button>
      </div>
    </div>
  );
}
