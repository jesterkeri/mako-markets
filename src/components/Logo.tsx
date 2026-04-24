import * as React from 'react';

type LogoProps = {
  /** Width in px. Height auto-scales via viewBox. */
  size?: number;
  className?: string;
  title?: string;
};

/**
 * Mako shark mark. Uses `currentColor` for fill+stroke so CSS `color`
 * drives the tint — `text-ink` on cream surfaces, `text-paper` on ink
 * surfaces. Stroke-width 3 softens the sharp tips without losing form
 * (matches the brand README guidance).
 *
 * Inlined rather than `<img>` so it renders crisply at any zoom and
 * inherits color without an extra round-trip.
 */
export function Logo({ size = 36, className, title }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="-3 -3 406 316"
      width={size}
      height={(size * 316) / 406}
      fill="currentColor"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      className={className}
    >
      {title ? <title>{title}</title> : null}
      <path
        d="M 25,285 L 80,259 C 80,227 112,177 123,169 L 115,251 L 150,259 C 160,186 246,135 246,135 C 246,135 226,156 211,196 C 196,235 196,259 196,259 L 239,308 C 229,222 306,86 380,5 C 298,40 193,111 160,153 C 160,153 155,132 163,104 C 170,76 184,50 183,47 C 112,81 44,221 25,285 Z"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
