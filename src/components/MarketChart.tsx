// ----------------------------------------------------------------------------
// src/components/MarketChart.tsx
//
// Detail-page chart slot. Renders header controls (instrument label,
// timeframe pills, zoom cluster, indicators dropdown, drawing-tools
// toggle, expand button) over a lazy-loaded `<CandlestickChart>` fed
// by `/api/charts`.
//
// Polish r8: krait drawing tools ported. PEN icon in header toggles
// a draggable toolbar with 9 tools (cursor, h-line, trend, ray,
// rectangle, fib, text, measure, eraser) + color picker + undo/redo
// + clear. DrawingCanvas overlays the chart with mouse interaction;
// DrawingEditor pops up when a drawing is selected.
// ----------------------------------------------------------------------------

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';

import { CandlestickChart } from '@/components/chart/CandlestickChart';
import { TimeframeSelector } from '@/components/chart/TimeframeSelector';
import { DrawingCanvas } from '@/components/chart/DrawingCanvas';
import { DrawingToolbar } from '@/components/chart/DrawingToolbar';
import { DrawingEditor } from '@/components/chart/DrawingEditor';
import type { ChartAssetClass } from '@/lib/chart-symbols';
import type { Candle, Timeframe } from '@/types/chart';
import type { ChartInnerHandle } from '@/components/chart/ChartInner';
import type { Drawing, DrawingTool } from '@/types/drawing';
import { DEFAULT_DRAWING_COLOR } from '@/types/drawing';

interface Props {
  oracleSymbol: string;
  assetClass: ChartAssetClass;
}

const TIMEFRAMES_BY_CLASS: Record<ChartAssetClass, readonly Timeframe[]> = {
  CRYPTO:      ['15m', '1h', '2h', '4h', '1d'],
  FOREX:       ['15m', '1h', '2h', '4h', '1d'],
  STOCKS:      ['15m', '1h', '2h', '4h', '1d'],
  COMMODITIES: ['15m', '1h', '1d'],
};

function defaultTimeframe(_assetClass: ChartAssetClass): Timeframe {
  return '1h';
}

const CHART_HEIGHT = 350;

interface ChartsResponse {
  candles: Candle[];
}

let drawingIdCounter = 0;
function newDrawingId(): string {
  drawingIdCounter += 1;
  return `d-${Date.now()}-${drawingIdCounter}`;
}

export function MarketChart({ oracleSymbol, assetClass }: Props) {
  const options = TIMEFRAMES_BY_CLASS[assetClass];
  const [tf, setTf] = useState<Timeframe>(defaultTimeframe(assetClass));
  const [expanded, setExpanded] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [showVolume, setShowVolume] = useState(false);
  const [showMA20, setShowMA20] = useState(false);
  const [showEMA50, setShowEMA50] = useState(false);
  const chartRef = useRef<ChartInnerHandle>(null);
  const toolsRef = useRef<HTMLDivElement>(null);

  // Drawing tools state (krait port)
  const [drawingsOpen, setDrawingsOpen] = useState(false);
  const [chartInstance, setChartInstance] = useState<IChartApi | null>(null);
  const [seriesInstance, setSeriesInstance] = useState<ISeriesApi<'Candlestick'> | null>(null);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [activeTool, setActiveTool] = useState<DrawingTool>('cursor');
  const [activeColor, setActiveColor] = useState(DEFAULT_DRAWING_COLOR);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [past, setPast] = useState<Drawing[][]>([]);
  const [future, setFuture] = useState<Drawing[][]>([]);

  const handleChartReady = useCallback(
    (chart: IChartApi | null, series: ISeriesApi<'Candlestick'> | null) => {
      setChartInstance(chart);
      setSeriesInstance(series);
    },
    [],
  );

  const snapshotForUndo = useCallback(() => {
    setPast((p) => [...p, drawings]);
    setFuture([]);
  }, [drawings]);

  const addDrawing = useCallback((d: Omit<Drawing, 'id'>) => {
    const id = newDrawingId();
    setPast((p) => [...p, drawings]);
    setFuture([]);
    setDrawings((curr) => [...curr, { ...d, id }]);
    return id;
  }, [drawings]);

  const updateDrawing = useCallback((id: string, updates: Partial<Drawing>) => {
    setDrawings((curr) => curr.map((d) => (d.id === id ? { ...d, ...updates } : d)));
  }, []);

  const removeDrawing = useCallback((id: string) => {
    setPast((p) => [...p, drawings]);
    setFuture([]);
    setDrawings((curr) => curr.filter((d) => d.id !== id));
    if (selectedId === id) setSelectedId(null);
  }, [drawings, selectedId]);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setFuture((f) => [drawings, ...f]);
      setDrawings(prev);
      return p.slice(0, -1);
    });
  }, [drawings]);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setPast((p) => [...p, drawings]);
      setDrawings(next);
      return f.slice(1);
    });
  }, [drawings]);

  const clearAll = useCallback(() => {
    if (drawings.length === 0) return;
    snapshotForUndo();
    setDrawings([]);
    setSelectedId(null);
  }, [drawings.length, snapshotForUndo]);

  // Render-phase reset on assetClass change. Drawings carry symbol-
  // specific price coordinates that don't map to a different asset,
  // so wipe them on symbol switch.
  const [prevAssetClass, setPrevAssetClass] = useState(assetClass);
  const [prevSymbol, setPrevSymbol] = useState(oracleSymbol);
  if (assetClass !== prevAssetClass) {
    setPrevAssetClass(assetClass);
    setTf(defaultTimeframe(assetClass));
  }
  if (oracleSymbol !== prevSymbol) {
    setPrevSymbol(oracleSymbol);
    setDrawings([]);
    setSelectedId(null);
    setPast([]);
    setFuture([]);
  }

  // ESC handling: tools dropdown → editor → drawings selection →
  // pending point → expanded overlay. Each layer consumes its own
  // dismissal so users can back out cleanly.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (toolsOpen) setToolsOpen(false);
      else if (selectedId) setSelectedId(null);
      else if (activeTool !== 'cursor') setActiveTool('cursor');
      else if (expanded) setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, toolsOpen, selectedId, activeTool]);

  useEffect(() => {
    if (!toolsOpen) return;
    const onClick = (e: MouseEvent) => {
      if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) {
        setToolsOpen(false);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [toolsOpen]);

  useEffect(() => {
    if (!expanded) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  const { data, isLoading, error, refetch, isFetching } = useQuery<ChartsResponse>({
    queryKey: ['charts', oracleSymbol, tf],
    queryFn: async () => {
      const url = `/api/charts?s=${encodeURIComponent(oracleSymbol)}&tf=${tf}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`charts route ${res.status}`);
      return (await res.json()) as ChartsResponse;
    },
    staleTime: 120_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const cardClass =
    'bg-paper border-2 border-ink rounded-2xl shadow-brutal-lg overflow-hidden';

  if (isLoading) {
    return (
      <div
        className={`${cardClass} animate-pulse rotate-[-1deg]`}
        style={{ height: CHART_HEIGHT + 64 }}
        aria-label="Loading chart"
      />
    );
  }

  if (error || !data?.candles?.length) {
    return (
      <div
        className={`${cardClass} flex flex-col items-center justify-center gap-4 p-8 min-h-[200px] rotate-[-1deg]`}
      >
        <div className="mako-label text-sm">CHART UNAVAILABLE</div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="mako-button mako-label text-xs disabled:opacity-50"
        >
          {isFetching ? 'RETRYING' : 'RETRY'}
        </button>
      </div>
    );
  }

  const iconBtnClass =
    'inline-flex items-center justify-center w-8 h-8 rounded-full border-2 border-ink bg-paper hover:bg-ink hover:text-paper transition-colors';

  const toggleRow = (label: string, active: boolean, onClick: () => void) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      className={`flex items-center justify-between gap-4 px-4 py-2 mako-label text-[11px] w-full text-left transition-colors ${
        active ? 'bg-ink text-paper' : 'bg-paper text-ink hover:bg-ink/5'
      }`}
    >
      <span>{label}</span>
      <span className="inline-flex items-center justify-center w-4 h-4 border-2 border-current rounded-sm">
        {active ? (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="square">
            <path d="M5 12l5 5 9-9" />
          </svg>
        ) : null}
      </span>
    </button>
  );

  const header = (
    <div className="flex items-center justify-between flex-wrap gap-3 px-5 py-3 border-b-2 border-ink relative">
      <span className="mako-mono text-xs tracking-widest text-muted">
        {oracleSymbol}
      </span>
      <div className="flex items-center gap-2 flex-wrap">
        <TimeframeSelector value={tf} onChange={setTf} options={options} />

        {/* Zoom cluster */}
        <div className="inline-flex items-stretch rounded-full border-2 border-ink overflow-hidden bg-paper">
          <button
            type="button"
            onClick={() => chartRef.current?.zoomOut()}
            aria-label="Zoom out"
            className="mako-label text-[14px] leading-none px-3 py-1.5 border-r-2 border-ink bg-paper text-ink hover:bg-ink/5"
          >
            -
          </button>
          <button
            type="button"
            onClick={() => chartRef.current?.fit()}
            aria-label="Fit chart"
            className="mako-label text-[10px] px-3 py-1.5 border-r-2 border-ink bg-paper text-ink hover:bg-ink/5"
          >
            FIT
          </button>
          <button
            type="button"
            onClick={() => chartRef.current?.zoomIn()}
            aria-label="Zoom in"
            className="mako-label text-[14px] leading-none px-3 py-1.5 bg-paper text-ink hover:bg-ink/5"
          >
            +
          </button>
        </div>

        {/* Drawing tools toggle */}
        <button
          type="button"
          onClick={() => {
            setDrawingsOpen((v) => !v);
            if (drawingsOpen) setActiveTool('cursor');
          }}
          aria-label={drawingsOpen ? 'Close drawing tools' : 'Open drawing tools'}
          aria-pressed={drawingsOpen}
          className={`${iconBtnClass} ${drawingsOpen ? 'bg-ink text-paper' : ''}`}
          title="Drawing tools"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter">
            <path d="M3 21l3-6 12-12 3 3-12 12-6 3z" />
            <path d="M14 6l4 4" />
          </svg>
        </button>

        {/* Indicators dropdown */}
        <div ref={toolsRef} className="relative">
          <button
            type="button"
            onClick={() => setToolsOpen((o) => !o)}
            aria-label="Indicators menu"
            aria-expanded={toolsOpen}
            className={`${iconBtnClass} ${toolsOpen ? 'bg-ink text-paper' : ''}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter">
              <path d="M4 18h6M14 18h6M4 12h2M10 12h10M4 6h12M20 6h0" />
            </svg>
          </button>
          {toolsOpen && (
            <div className="absolute right-0 top-full mt-2 z-30 w-44 bg-paper border-2 border-ink rounded-xl shadow-brutal-sm overflow-hidden">
              <div className="mako-label text-[9px] text-muted px-4 py-2 border-b-2 border-ink bg-surface-elevated">
                INDICATORS
              </div>
              {assetClass !== 'FOREX' &&
                toggleRow('VOLUME', showVolume, () => setShowVolume((v) => !v))}
              {toggleRow('MA (20)', showMA20, () => setShowMA20((v) => !v))}
              {toggleRow('EMA (50)', showEMA50, () => setShowEMA50((v) => !v))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-label={expanded ? 'Collapse chart' : 'Expand chart'}
          className={iconBtnClass}
        >
          {expanded ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );

  // Drawing layer + editor pop-up. Shared between collapsed + expanded
  // forms so toggle state survives the transition.
  const selectedDrawing = selectedId
    ? drawings.find((d) => d.id === selectedId) ?? null
    : null;

  const drawingLayer = (
    <>
      <DrawingCanvas
        chart={chartInstance}
        series={seriesInstance}
        drawings={drawings}
        activeTool={activeTool}
        activeColor={activeColor}
        selectedId={selectedId}
        onAddDrawing={addDrawing}
        onUpdateDrawing={updateDrawing}
        onRemoveDrawing={removeDrawing}
        onSelectDrawing={setSelectedId}
      />
      <DrawingToolbar
        visible={drawingsOpen}
        activeTool={activeTool}
        activeColor={activeColor}
        canUndo={past.length > 0}
        canRedo={future.length > 0}
        onToolChange={setActiveTool}
        onColorChange={setActiveColor}
        onUndo={undo}
        onRedo={redo}
        onClearAll={clearAll}
        onClose={() => {
          setDrawingsOpen(false);
          setActiveTool('cursor');
        }}
      />
      {selectedDrawing && (
        <DrawingEditor
          drawing={selectedDrawing}
          position={{ x: 16, y: 16 }}
          onUpdate={updateDrawing}
          onDelete={removeDrawing}
          onClose={() => setSelectedId(null)}
        />
      )}
    </>
  );

  if (expanded) {
    const overlay = (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6 bg-ink/80 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-label="Expanded price chart"
        onClick={(e) => {
          if (e.target === e.currentTarget) setExpanded(false);
        }}
      >
        <div
          className={`${cardClass} w-full max-w-[1600px] flex flex-col`}
          style={{ height: 'calc(100vh - 4rem)' }}
        >
          {header}
          <div
            className="flex-1 relative"
            style={{ minHeight: 0, height: 'calc(100vh - 4rem - 80px)' }}
          >
            <CandlestickChart
              ref={chartRef}
              candles={data.candles}
              instrument={oracleSymbol}
              assetClass={assetClass}
              timeframe={tf}
              height={undefined}
              showVolume={showVolume}
              showMA20={showMA20}
              showEMA50={showEMA50}
              onChartReady={handleChartReady}
            />
            {drawingLayer}
          </div>
        </div>
      </div>
    );

    return (
      <>
        <div
          className="bg-paper/30 border-2 border-dashed border-ink/30 rounded-2xl flex items-center justify-center"
          style={{ height: CHART_HEIGHT + 64 }}
          aria-hidden
        >
          <span className="mako-label text-muted text-xs">CHART EXPANDED · PRESS ESC TO CLOSE</span>
        </div>
        {typeof document !== 'undefined' ? createPortal(overlay, document.body) : null}
      </>
    );
  }

  return (
    <div className={`${cardClass} rotate-[-1deg]`}>
      {header}
      <div className="relative" style={{ height: CHART_HEIGHT }}>
        <CandlestickChart
          ref={chartRef}
          candles={data.candles}
          instrument={oracleSymbol}
          assetClass={assetClass}
          timeframe={tf}
          height={CHART_HEIGHT}
          showVolume={showVolume}
          showMA20={showMA20}
          showEMA50={showEMA50}
          onChartReady={handleChartReady}
        />
        {drawingLayer}
      </div>
    </div>
  );
}
