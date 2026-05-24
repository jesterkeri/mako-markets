// ----------------------------------------------------------------------------
// src/components/chart/DrawingToolbar.tsx
//
// Floating, draggable toolbar with drawing tools, color picker, undo/
// redo, clear, close. Ported from krait + restyled to mako neobrutal
// (cream paper + ink borders + brutal shadow, replacing krait's dark
// glass surface).
// ----------------------------------------------------------------------------

'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { DrawingTool } from '@/types/drawing';
import { DRAWING_COLORS } from '@/types/drawing';

interface Props {
  visible: boolean;
  activeTool: DrawingTool;
  activeColor: string;
  canUndo: boolean;
  canRedo: boolean;
  onToolChange: (tool: DrawingTool) => void;
  onColorChange: (color: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onClearAll: () => void;
  onClose: () => void;
}

function IconCursor() { return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 3l5 14 2.5-5.5L17 9L4 3z" /></svg>; }
function IconHLine() { return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><line x1="2" y1="10" x2="18" y2="10" /><circle cx="2" cy="10" r="1.5" fill="currentColor" /><circle cx="18" cy="10" r="1.5" fill="currentColor" /></svg>; }
function IconTrend() { return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><line x1="3" y1="16" x2="17" y2="4" /><circle cx="3" cy="16" r="1.5" fill="currentColor" /><circle cx="17" cy="4" r="1.5" fill="currentColor" /></svg>; }
function IconRay() { return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><line x1="3" y1="10" x2="18" y2="10" /><circle cx="3" cy="10" r="1.5" fill="currentColor" /><path d="M15 7l3 3-3 3" /></svg>; }
function IconRect() { return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="14" height="10" rx="0.5" /></svg>; }
function IconFib() { return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.5 2"><line x1="2" y1="4" x2="18" y2="4" /><line x1="2" y1="8" x2="18" y2="8" /><line x1="2" y1="10" x2="18" y2="10" strokeDasharray="0" /><line x1="2" y1="12.5" x2="18" y2="12.5" /><line x1="2" y1="16" x2="18" y2="16" /></svg>; }
function IconText() { return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 4h10M10 4v12M7 16h6" /></svg>; }
function IconMeasure() { return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 17L17 3" /><path d="M3 17v-5M3 17h5" /><path d="M17 3v5M17 3h-5" /></svg>; }
function IconEraser() { return <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M13 3l4 4-8 8H5L3 11l10-8z" /><line x1="9" y1="15" x2="17" y2="15" /></svg>; }
function IconUndo() { return <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 9l-4-4 4-4" /><path d="M1 5h12a5 5 0 010 10H7" /></svg>; }
function IconRedo() { return <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M15 9l4-4-4-4" /><path d="M19 5H7a5 5 0 000 10h6" /></svg>; }
function IconTrash() { return <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 5h14M7 5V4a1 1 0 011-1h4a1 1 0 011 1v1M8 9v5M12 9v5" /><path d="M4 5l1 12a1 1 0 001 1h8a1 1 0 001-1l1-12" /></svg>; }
function IconClose() { return <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 5l10 10M15 5L5 15" /></svg>; }
function IconGrip() { return <svg width="10" height="14" viewBox="0 0 16 20" fill="currentColor" opacity="0.45"><circle cx="5" cy="5" r="1.3"/><circle cx="11" cy="5" r="1.3"/><circle cx="5" cy="10" r="1.3"/><circle cx="11" cy="10" r="1.3"/><circle cx="5" cy="15" r="1.3"/><circle cx="11" cy="15" r="1.3"/></svg>; }

interface ToolDef { tool: DrawingTool; icon: React.FC; label: string; shortcut?: string }
const TOOL_GROUPS: { tools: ToolDef[] }[] = [
  { tools: [{ tool: 'cursor', icon: IconCursor, label: 'Cursor', shortcut: 'Esc' }] },
  { tools: [
    { tool: 'horizontal-line', icon: IconHLine,  label: 'H-Line' },
    { tool: 'trend-line',      icon: IconTrend,  label: 'Trend' },
    { tool: 'horizontal-ray',  icon: IconRay,    label: 'Ray' },
  ]},
  { tools: [
    { tool: 'rectangle', icon: IconRect, label: 'Rect' },
    { tool: 'fibonacci', icon: IconFib,  label: 'Fib' },
  ]},
  { tools: [
    { tool: 'text',    icon: IconText,    label: 'Text' },
    { tool: 'measure', icon: IconMeasure, label: 'Measure' },
  ]},
  { tools: [{ tool: 'eraser', icon: IconEraser, label: 'Eraser' }] },
];

function ColorPicker({ activeColor, onChange }: { activeColor: string; onChange: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        onClick={() => setOpen(!open)}
        title="Drawing color"
        className="w-6 h-6 rounded-full border-2 border-paper cursor-pointer p-0"
        style={{ background: activeColor }}
      />
      {open && (
        <div
          className="absolute top-[calc(100%+10px)] left-1/2 -translate-x-1/2 z-40 bg-ink border-2 border-paper rounded-xl shadow-brutal-sm p-4"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="mako-label text-[9px] text-paper/60 tracking-widest mb-3 px-0.5">
            COLOR
          </div>
          {/* Inline-flex with wrap + generous gap so each swatch is
              clearly an independent circle — no rings spilling into
              neighbours. Active state uses a tight 2px paper ring
              that hugs the circle (no offset). */}
          <div className="flex flex-wrap gap-3 max-w-[176px]">
            {DRAWING_COLORS.map((color) => {
              const active = activeColor === color;
              return (
                <button
                  key={color}
                  onClick={() => { onChange(color); setOpen(false); }}
                  title={color}
                  className="w-7 h-7 rounded-full p-0 cursor-pointer transition-shadow"
                  style={{
                    background: color,
                    boxShadow: active
                      ? '0 0 0 2px #EBE5D9'
                      : undefined,
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.boxShadow = '0 0 0 2px rgba(235,229,217,0.5)';
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.boxShadow = '';
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Divider() {
  return <div className="w-px h-5 bg-paper/30 mx-0.5 shrink-0" />;
}

function useDraggable(initialPos: { x: number; y: number }) {
  const [pos, setPos] = useState(initialPos);
  const dragging = useRef(false);
  const offset = useRef({ x: 0, y: 0 });

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    offset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      setPos({ x: e.clientX - offset.current.x, y: e.clientY - offset.current.y });
    };
    const up = () => { dragging.current = false; };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    return () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
  }, []);

  return { pos, onMouseDown };
}

export function DrawingToolbar({
  visible, activeTool, activeColor, canUndo, canRedo,
  onToolChange, onColorChange, onUndo, onRedo, onClearAll, onClose,
}: Props) {
  const { pos, onMouseDown } = useDraggable({ x: 12, y: 60 });
  const ref = useRef<HTMLDivElement>(null);

  if (!visible) return null;

  return (
    <div
      ref={ref}
      data-drawing-toolbar
      onMouseDown={(e) => e.stopPropagation()}
      className="absolute z-30 flex items-center gap-1 px-2 py-1.5 bg-ink border-2 border-ink rounded-xl shadow-brutal text-paper"
      style={{ top: pos.y, left: pos.x }}
    >
      <div
        onMouseDown={onMouseDown}
        className="cursor-grab px-1 flex items-center shrink-0 text-paper"
        title="Drag to move"
      >
        <IconGrip />
      </div>
      <Divider />

      {TOOL_GROUPS.map((group, gi) => (
        <div key={gi} className="contents">
          {gi > 0 && <Divider />}
          {group.tools.map(({ tool, icon: Icon, label, shortcut }) => {
            const active = activeTool === tool;
            return (
              <button
                key={tool}
                onClick={() => onToolChange(tool)}
                title={`${label}${shortcut ? ` (${shortcut})` : ''}`}
                className={`w-8 h-8 flex items-center justify-center border-2 rounded-md transition-colors ${
                  active
                    ? 'bg-paper text-ink border-paper'
                    : 'bg-ink text-paper border-transparent hover:bg-paper/10'
                }`}
              >
                <Icon />
              </button>
            );
          })}
        </div>
      ))}

      <Divider />
      <ColorPicker activeColor={activeColor} onChange={onColorChange} />
      <Divider />

      <button
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo"
        className="w-7 h-8 flex items-center justify-center text-paper rounded-md hover:bg-paper/10 disabled:opacity-30 disabled:cursor-default"
      >
        <IconUndo />
      </button>
      <button
        onClick={onRedo}
        disabled={!canRedo}
        title="Redo"
        className="w-7 h-8 flex items-center justify-center text-paper rounded-md hover:bg-paper/10 disabled:opacity-30 disabled:cursor-default"
      >
        <IconRedo />
      </button>
      <button
        onClick={onClearAll}
        title="Clear all"
        className="w-7 h-8 flex items-center justify-center text-mako-red rounded-md hover:bg-mako-red/15"
      >
        <IconTrash />
      </button>

      <Divider />

      <button
        onClick={onClose}
        title="Close toolbar"
        className="w-7 h-8 flex items-center justify-center text-paper rounded-md hover:bg-paper/10"
      >
        <IconClose />
      </button>
    </div>
  );
}
