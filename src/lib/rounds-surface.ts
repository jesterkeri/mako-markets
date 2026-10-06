// ----------------------------------------------------------------------------
// src/lib/rounds-surface.ts
//
// Three copies of the Rounds sponsored surface must agree exactly (Codex T1.4 r2): this app's ROUND_SPONSORED and
// roundsAbi, the contracts repository's surface gate (`script/check-surface.mjs`, SPONSORED), and the MakoRoundsV1
// that repository compiles at ROUNDS_CONTRACTS_COMMIT. Each local test only checks its own copy, so a change to one
// side with its own literal updated would stay green; this comparison is what a one-sided change fails. CI runs it
// against a fresh checkout of jesterkeri/mako-contracts at the pinned commit (`rounds-surface.test.ts`).
// ----------------------------------------------------------------------------

/// The mako-contracts commit whose MakoRoundsV1 this app targets: the deployment record on the T1.5 deploy branch
/// (1d787f6 adds only the broadcast and the verified receipt to c79c9d0, Codex SHIP, CONTRACTS_R3_REVIEW.md). Its
/// src/MakoRoundsV1.sol is unchanged since d946901 (Codex T1.1 SHIP). Moving it is a reviewed change, made together
/// with regenerating rounds-abi.ts.
export const ROUNDS_CONTRACTS_COMMIT = '1d787f66838a85a561ac12575300968bcf66c905';

export interface SurfaceInput {
  /// This app's sponsored map, signature -> 0x selector.
  appSponsored: Readonly<Record<string, string>>;
  /// This app's generated ABI.
  appAbi: readonly unknown[];
  /// The contracts gate's SPONSORED, signature -> selector (with or without 0x).
  gateSponsored: Readonly<Record<string, string>>;
  /// `forge inspect MakoRoundsV1 methodIdentifiers --json`: signature -> selector without 0x.
  compiledIds: Readonly<Record<string, string>>;
  /// `forge inspect MakoRoundsV1 abi --json`.
  compiledAbi: readonly unknown[];
}

const sel = (s: string) => s.toLowerCase().replace(/^0x/, '');
const keys = (m: Readonly<Record<string, string>>) => Object.keys(m).sort();

/// Every way the three copies disagree; empty when they match exactly.
export function roundsSurfaceProblems(i: SurfaceInput): string[] {
  const problems: string[] = [];
  const app = keys(i.appSponsored);
  const gate = keys(i.gateSponsored);
  if (app.length !== 4) problems.push(`the app sponsors ${app.length} Rounds functions, not exactly four`);
  if (JSON.stringify(app) !== JSON.stringify(gate)) {
    problems.push(`sponsored signatures differ: app [${app.join(', ')}], contracts gate [${gate.join(', ')}]`);
  }
  for (const sig of new Set([...app, ...gate])) {
    const compiled = i.compiledIds[sig];
    if (compiled === undefined) {
      problems.push(`${sig} is not a function of the compiled MakoRoundsV1`);
      continue;
    }
    if (sig in i.appSponsored && sel(i.appSponsored[sig]) !== sel(compiled)) {
      problems.push(`${sig}: app selector 0x${sel(i.appSponsored[sig])}, compiled 0x${sel(compiled)}`);
    }
    if (sig in i.gateSponsored && sel(i.gateSponsored[sig]) !== sel(compiled)) {
      problems.push(`${sig}: contracts gate selector 0x${sel(i.gateSponsored[sig])}, compiled 0x${sel(compiled)}`);
    }
  }
  if (JSON.stringify(i.appAbi) !== JSON.stringify(i.compiledAbi)) {
    problems.push('the app roundsAbi is not the compiled MakoRoundsV1 ABI at the pinned commit; regenerate it');
  }
  return problems;
}

/// The SPONSORED object literal of the contracts gate script, read as data (the script runs forge on import).
export function parseGateSponsored(source: string): Record<string, string> {
  const block = /const SPONSORED = \{([^}]*)\};/.exec(source);
  if (!block) throw new Error('SPONSORED not found in check-surface.mjs');
  const out: Record<string, string> = {};
  // One entry per line, each exactly `'signature': 'selector',`; any other line is refused, never skipped.
  for (const line of block[1].split('\n').map((x) => x.trim()).filter(Boolean)) {
    const m = /^'([^']+)':\s*'([0-9a-fA-F]{8})',?$/.exec(line);
    if (!m) throw new Error('SPONSORED has an entry this parser cannot read');
    out[m[1]] = m[2];
  }
  return out;
}
