import * as React from "react";

export interface AdminTableProps {
  columns: string[];
  data: any[];
  onRowClick?: (row: any) => void;
}

export function AdminTable({ columns, data, onRowClick }: AdminTableProps) {
  if (!data || data.length === 0) {
    return (
      <div className="w-full bg-surface-elevated border-2 border-ink border-dashed p-8 rounded-xl text-center">
        <span className="mako-label text-muted">NO DATA</span>
      </div>
    );
  }

  return (
    <div className="w-full overflow-x-auto bg-paper border-2 border-ink rounded-xl shadow-[4px_4px_0_0_#000000]">
      <table className="w-full text-left border-collapse min-w-[600px]">
        <thead>
          <tr className="bg-surface-elevated border-b-2 border-ink">
            {columns.map((col, i) => (
              <th key={i} className="p-4 mako-label text-ink whitespace-nowrap">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr 
              key={i} 
              onClick={() => onRowClick?.(row)}
              className={`border-b border-ink/20 last:border-0 transition-colors ${onRowClick ? 'cursor-pointer hover:bg-signal/20' : ''}`}
            >
              {columns.map((col, j) => (
                <td key={j} className="p-4 mako-body text-ink whitespace-nowrap">
                  {/* Simplistic render for object values, wait for Claude to expand */}
                  {String(row[col.toLowerCase()] || "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
