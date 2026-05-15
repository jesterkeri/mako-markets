'use client';

import { useEffect, useRef, useState } from 'react';
import { DayPicker } from 'react-day-picker';
import { format, parse } from 'date-fns';

// ----------------------------------------------------------------------------
// src/components/DateTimePicker.tsx
//
// Brand-styled drop-in for <input type="datetime-local">. Value contract is
// identical: ISO-like `YYYY-MM-DDTHH:MM` string, empty string when blank.
// Uses react-day-picker (headless) for the calendar grid and styled
// <select> elements for hour + minute. Click-outside / ESC closes the
// popover. Theme-neutral via brand tokens only.
// ----------------------------------------------------------------------------

const ISO_FORMAT = "yyyy-MM-dd'T'HH:mm";
const DISPLAY_FORMAT = 'MMM d, yyyy   HH:mm';

function parseValue(value: string): { date: Date | undefined; hour: number; minute: number } {
  if (!value) return { date: undefined, hour: 12, minute: 0 };
  try {
    const parsed = parse(value, ISO_FORMAT, new Date());
    if (isNaN(parsed.getTime())) return { date: undefined, hour: 12, minute: 0 };
    return { date: parsed, hour: parsed.getHours(), minute: parsed.getMinutes() };
  } catch {
    return { date: undefined, hour: 12, minute: 0 };
  }
}

function formatValue(date: Date, hour: number, minute: number): string {
  const d = new Date(date);
  d.setHours(hour, minute, 0, 0);
  return format(d, ISO_FORMAT);
}

interface DateTimePickerProps {
  value: string;
  onChange: (next: string) => void;
  hasError?: boolean;
}

export function DateTimePicker({ value, onChange, hasError }: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { date, hour, minute } = parseValue(value);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const handleDateSelect = (next: Date | undefined) => {
    if (!next) return;
    onChange(formatValue(next, hour, minute));
  };

  const handleHourChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextHour = parseInt(e.target.value, 10);
    const base = date ?? new Date();
    onChange(formatValue(base, nextHour, minute));
  };

  const handleMinuteChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextMinute = parseInt(e.target.value, 10);
    const base = date ?? new Date();
    onChange(formatValue(base, hour, nextMinute));
  };

  const displayLabel = date ? format(date, DISPLAY_FORMAT) : 'PICK DATE & TIME';

  const triggerClasses = `w-full border-2 rounded-xl px-4 py-3 font-display font-bold text-lg outline-none focus:border-accent bg-paper transition-colors text-left flex items-center justify-between ${
    hasError ? 'border-mako-red text-mako-red' : 'border-ink text-ink'
  } ${!date ? 'text-muted' : ''}`;

  const selectClasses =
    'border-2 border-ink rounded-lg px-2 py-2 font-display font-bold text-base bg-paper text-ink outline-none focus:border-accent';

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={triggerClasses}
      >
        <span>{displayLabel}</span>
        <span className="mako-label text-muted">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="absolute z-50 mt-2 left-0 bg-paper border-2 border-ink rounded-xl w-[340px] overflow-hidden divide-y-2 divide-ink">
          <div className="px-4 pt-4 pb-3">
            <DayPicker
              mode="single"
              selected={date}
              onSelect={handleDateSelect}
              defaultMonth={date ?? new Date()}
              classNames={{
                root: 'font-display text-ink',
                months: 'flex',
                month: 'flex flex-col gap-3 w-full',
                month_caption: 'flex justify-center items-center h-10',
                caption_label: 'font-display font-black text-2xl uppercase tracking-tight text-ink',
                nav: 'flex items-center justify-between absolute top-3 left-3 right-3 z-10 pointer-events-none',
                button_previous:
                  'pointer-events-auto w-10 h-10 flex items-center justify-center border-2 border-ink bg-paper text-ink font-display font-black text-xl rounded-md hover:bg-ink hover:text-paper transition-colors',
                button_next:
                  'pointer-events-auto w-10 h-10 flex items-center justify-center border-2 border-ink bg-paper text-ink font-display font-black text-xl rounded-md hover:bg-ink hover:text-paper transition-colors',
                month_grid: 'w-full border-collapse',
                weekdays: 'flex w-full',
                weekday: 'mako-label text-muted flex-1 text-center text-[10px] py-2',
                week: 'flex w-full',
                day: 'flex-1 aspect-square text-center text-base font-display font-bold text-ink cursor-pointer',
                day_button:
                  'w-full h-full flex items-center justify-center hover:bg-ink hover:text-paper transition-colors',
                selected:
                  '[&_button]:bg-ink [&_button]:text-paper [&_button]:hover:bg-ink [&_button]:hover:text-paper',
                today: '[&_button]:border-2 [&_button]:border-mako-red',
                outside: 'text-subtle opacity-30',
                disabled: 'text-subtle opacity-30 cursor-not-allowed',
              }}
            />
          </div>

          <div className="flex items-center gap-2 px-4 py-3 bg-surface-elevated">
            <label className="mako-label text-muted">TIME</label>
            <select value={hour} onChange={handleHourChange} className={selectClasses}>
              {Array.from({ length: 24 }, (_, i) => (
                <option key={i} value={i}>
                  {i.toString().padStart(2, '0')}
                </option>
              ))}
            </select>
            <span className="font-display font-black text-xl text-ink">:</span>
            <select value={minute} onChange={handleMinuteChange} className={selectClasses}>
              {Array.from({ length: 60 }, (_, i) => (
                <option key={i} value={i}>
                  {i.toString().padStart(2, '0')}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="ml-auto bg-ink text-paper mako-label px-4 py-2 rounded-md hover:opacity-90 transition-opacity"
            >
              DONE
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
