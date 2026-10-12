/**
 * Mako Market tokens as hex (animated colours must be hex: interpolateColors cannot parse color-mix()).
 * Sources: src/app/globals.css ([data-theme="dark"]), src/app/mako-shell.css (--line/--raise/--raise2/--dim are
 * color-mix of canvas-fg over canvas at 12/6/10/60%), .claude/BRAND.md (paper, red rule).
 * Text cream is #EDE6D6 per the film brief (the app's canvas-fg is #EBE5D9, a hair apart).
 */
export const C = {
  ink: "#000000",
  fg: "#EDE6D6",
  paper: "#EBE5D9",
  paperRaised: "#E1DBCB",
  paperSunk: "#D6CFBE",
  signal: "#FACC15",
  red: "#D94A3D",
  raise: "#0E0E0D", // 6% fg over black (--raise)
  raise2: "#181715", // 10% (--raise2)
  line: "#1C1C1A", // 12% (--line)
  dim: "#8E8A80", // 60% (--dim)
  grid: "#0F0F0E", // chart grid, rgba(235,229,217,0.06)
} as const;

export const FONT = {
  display: '"Bricolage Grotesque", sans-serif',
  sans: '"Inter", sans-serif',
  mono: '"JetBrains Mono", monospace',
} as const;

/** The product's own press and settle curves (mako-shell.css: mk-press96, pot bar width). */
export const EASE = {
  press: [0.23, 1, 0.32, 1] as const,
  land: [0.22, 1, 0.36, 1] as const,
};

/** Mako Market mark, from public/logos/mako-logo.svg (viewBox -3 -3 406 316). */
export const LOGO_PATH =
  "M 25,285 L 80,259 C 80,227 112,177 123,169 L 115,251 L 150,259 C 160,186 246,135 246,135 C 246,135 226,156 211,196 C 196,235 196,259 196,259 L 239,308 C 229,222 306,86 380,5 C 298,40 193,111 160,153 C 160,153 155,132 163,104 C 170,76 184,50 183,47 C 112,81 44,221 25,285 Z";
