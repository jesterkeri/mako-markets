// Number formats the redesign uses in the shell.

/// 75942.22 -> "$75,942.22"
export function usd2(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/// 1.84 -> "+1.84%", -2.75 -> "−2.75%" (a true minus sign, as in the design).
export function pct2(n: number): string {
  return `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(2)}%`;
}
