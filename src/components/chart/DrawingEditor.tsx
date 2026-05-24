// ----------------------------------------------------------------------------
// src/components/chart/DrawingEditor.tsx
//
// Popover for editing the currently-selected drawing (color, line
// width, line style, lock, delete). Ported from krait + restyled
// to mako neobrutal.
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

function IconTrash() { return <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 5h14M7 5V4a1 1 0 011-1h4a1 1 0 011 1v1M8 9v5M12 9v5" /><path d="M4 5l1 12a1 1 0 001 1h8a1 1 0 001-1l1-12" /></svg>; }
function IconLock() { return <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="9" width="12" height="9" rx="1" /><path d="M7 9V6a3 3 0 016 0v3" /></svg>; }
function IconUnlock() { return <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="9" width="12" height="9" rx="1" /><path d="M7 9V6a3 3 0 016 0" /></svg>; }
function IconGrip() { return <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" opacity="0.45"><circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/></svg>; }
function IconClose() { return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square"><path d="M3 3l10 10M13 3L3 13" /></svg>; }

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

  const onDragStart = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startClient.current = { x: e.clientX, y: e.clientY };
    startPos.current = { x: pos.x, y: pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - startClient.current.x;
      const dy = e.clientY - startClient.current.y;
      setPos({ x: startPos.current.x + dx, y: startPos.current.y + dy });
    };
    const up = () => { dragging.current = false; };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    return () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const timer = setTimeout(() => document.addEventListener('mousedown', handler), 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      data-drawing-editor
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute z-40 flex flex-col gap-2.5 p-3 bg-paper border-2 border-ink rounded-xl shadow-brutal min-w-[220px]"
      style={{ top: pos.y, left: pos.x }}
    >
      {/* Drag header */}
      <div
        onMouseDown={onDragStart}
        className="flex justify-between items-center cursor-grab select-none"
      >
        <div className="flex items-center gap-1.5">
          <IconGrip />
          <span className="mako-label text-[9px] tracking-widest text-muted">
            {drawing.type.replace('-', ' ')}
          </span>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="text-ink/60 hover:text-ink p-0.5 leading-none"
        >
          <IconClose />
        </button>
      </div>

      {/* Color */}
      <div>
        <div className="mako-label text-[9px] text-muted mb-1.5">Color</div>
        <div className="flex gap-1">
          {DRAWING_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => onUpdate(drawing.id, { color: c })}
              className="w-5 h-5 rounded-full p-0 cursor-pointer border-2"
              style={{
                background: c,
                borderColor: drawing.color === c ? 'var(--mako-ink)' : 'transparent',
              }}
            />
          ))}
        </div>
      </div>

      {/* Width */}
      <div>
        <div className="mako-label text-[9px] text-muted mb-1.5">Width</div>
        <div className="flex gap-1">
          {LINE_WIDTHS.map((w) => (
            <button
              key={w}
              onClick={() => onUpdate(drawing.id, { lineWidth: w })}
              className={`w-8 h-7 flex items-center justify-center border-2 rounded-md cursor-pointer ${
                drawing.lineWidth === w ? 'bg-ink/5 border-ink' : 'bg-paper border-ink/20'
              }`}
            >
              <div className="w-4 bg-ink rounded-sm" style={{ height: w }} />
            </button>
          ))}
        </div>
      </div>

      {/* Style */}
      <div>
        <div className="mako-label text-[9px] text-muted mb-1.5">Style</div>
        <div className="flex gap-1">
          {LINE_STYLES.map((s) => (
            <button
              key={s.value}
              onClick={() => onUpdate(drawing.id, { lineStyle: s.value })}
              className={`flex-1 h-7 flex items-center justify-center border-2 rounded-md cursor-pointer ${
                drawing.lineStyle === s.value ? 'bg-ink/5 border-ink' : 'bg-paper border-ink/20'
              }`}
            >
              <svg width="28" height="2" viewBox="0 0 28 2">
                <line x1="0" y1="1" x2="28" y2="1" stroke="var(--mako-ink)" strokeWidth="1.5" strokeDasharray={s.dash} />
              </svg>
            </button>
          ))}
        </div>
      </div>

      <div className="h-px bg-ink/15" />

      {/* Actions */}
      <div className="flex gap-1.5">
        <button
          onClick={() => onUpdate(drawing.id, { locked: !drawing.locked })}
          className={`flex-1 h-7 flex items-center justify-center gap-1.5 border-2 border-ink rounded-md mako-label text-[10px] cursor-pointer ${
            drawing.locked ? 'bg-signal text-ink' : 'bg-paper text-ink hover:bg-ink/5'
          }`}
        >
          {drawing.locked ? <IconLock /> : <IconUnlock />}
          {drawing.locked ? 'Locked' : 'Lock'}
        </button>
        <button
          onClick={() => { onDelete(drawing.id); onClose(); }}
          className="flex-1 h-7 flex items-center justify-center gap-1.5 border-2 border-mako-red rounded-md mako-label text-[10px] cursor-pointer bg-mako-red/10 text-mako-red hover:bg-mako-red/20"
        >
          <IconTrash /> Delete
        </button>
      </div>
    </div>
  );
}
