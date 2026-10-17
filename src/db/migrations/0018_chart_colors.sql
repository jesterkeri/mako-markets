-- Candle colours chosen on the charts (Joshua 2026-10-17): users.chart_colors holds the six TradingView colours
-- {upBody, downBody, upBorder, downBorder, upWick, downWick} as lower-case #rrggbb; NULL = TradingView's defaults.
-- Written only by /api/user/chart-colors, which validates the shape (src/lib/chart-colors.ts parseChartColors).
-- Additive and nullable: older code that does not name the column keeps working.
--
-- Verification (after `pnpm db:migrate`): \d users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "chart_colors" jsonb;
