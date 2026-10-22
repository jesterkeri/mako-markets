// For the chart-colour tests' fake servers: what POST /api/user/chart-colors stores for a request body, as the route
// does since adversary r10 on 2d48a79 (only the changed colours are sent and merged into what is held; null resets).
import { mergeChartColors, type ChartColors } from '../chart-colors';

export function applySave(held: unknown, body: { patch?: Partial<ChartColors> | null }): ChartColors | null {
  return body.patch === null || body.patch === undefined ? null : mergeChartColors((held as ChartColors | null) ?? null, body.patch);
}
