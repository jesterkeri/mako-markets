// ----------------------------------------------------------------------------
// recovery-codes-export.ts
//
// Pure helpers extracted from RecoveryCodesPanel for COPY ALL +
// DOWNLOAD .txt content building. The component imports these so the
// bytes the user receives are deterministic and unit-testable under
// the Node vitest environment.
//
// COPY format:    tab-separated single line ("AAAA-BBBB-CC\tCCCC-DDDD-EE...")
// DOWNLOAD format:
//   <header line>
//   (blank line)
//   <code 1>
//   <code 2>
//   ...
//   <trailing newline>
// Filename: mako-recovery-codes-YYYY-MM-DD.txt
// ----------------------------------------------------------------------------

export function formatRecoveryCodesForCopy(codes: string[]): string {
  return codes.join('\t');
}

export function formatRecoveryCodesForDownload(
  codes: string[],
  date: Date,
): { content: string; filename: string } {
  const ymd = formatYmd(date);
  const header = `Mako Market recovery codes — store somewhere safe — generated ${ymd}`;
  const content = `${header}\n\n${codes.join('\n')}\n`;
  const filename = `mako-recovery-codes-${ymd}.txt`;
  return { content, filename };
}

function formatYmd(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
