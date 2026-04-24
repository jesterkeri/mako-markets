import * as React from "react";

export interface ChartDataPoint {
  date: string;
  value: number;
}

export interface AnalyticsChartsProps {
  title: string;
  data: ChartDataPoint[];
  isLoading?: boolean;
}

export const MOCK_CHART_DATA: ChartDataPoint[] = [
  { date: "Mon", value: 1200 },
  { date: "Tue", value: -400 },
  { date: "Wed", value: 1550 },
  { date: "Thu", value: 800 },
  { date: "Fri", value: -120 },
  { date: "Sat", value: 2400 },
  { date: "Sun", value: 1900 },
];

export function AnalyticsCharts({ title, data, isLoading = false }: AnalyticsChartsProps) {
  // Simplified CSS-based bar chart. 
  // Wait for Claude to wire real Recharts/Chart.js logic, but keeping the visual styles here.

  if (isLoading) {
    return <div className="mako-skeleton w-full h-64" />;
  }

  const maxValue = Math.max(...data.map(d => Math.abs(d.value)), 1);

  return (
    <div className="w-full bg-paper border-2 border-ink rounded-xl shadow-[4px_4px_0_0_#000000] p-6">
      <h3 className="mako-title text-xl mb-8">{title}</h3>
      
      <div className="h-48 flex items-end gap-2 sm:gap-4 relative px-2 mb-4 border-b-2 border-ink border-dashed">
        {data.map((point, i) => {
          const heightPct = (Math.abs(point.value) / maxValue) * 100;
          const isNegative = point.value < 0;
          
          return (
            <div key={i} className="group relative flex-1 flex flex-col justify-end items-center h-full">
               <div 
                 className={`w-full max-w-[40px] border-2 border-ink transition-all ${isNegative ? 'bg-mako-red' : 'bg-ink'}`} 
                 style={{ height: `${heightPct}%` }}
               />
               <span className="mako-label text-muted text-[10px] mt-2 block w-full text-center truncate">
                 {point.date}
               </span>
               <div className="hidden group-hover:block absolute top-0 -translate-y-10 z-10 mako-label bg-paper border-2 border-ink px-2 py-1 rounded shadow-[2px_2px_0_0_#000000]">
                  ${point.value}
               </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
