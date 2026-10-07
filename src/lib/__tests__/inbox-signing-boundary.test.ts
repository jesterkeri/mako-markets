// INBOX_GAP_PLAN r18 item 3 and [G1], as a build gate over the source: (1) Mako Market never offers to remove the
// authenticator, so no module calls Privy's MFA screen (it has "Remove") or any unenroll method; (2) the embedded
// wallet's signing and export are reached only from the listed modules, so a new signing path cannot appear
// unreviewed. Each allow-list entry carries its reason; adding one is a reviewed change to this file.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}
const FILES = sourceFiles(SRC).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
/// Code only: line comments and block comments removed, so a comment that names a call is not a call.
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const filesMatching = (re: RegExp) => FILES.filter((f) => re.test(code(f.text))).map((f) => f.path).sort();

describe('the authenticator is never removable from Mako Market [G1]', () => {
  it('no module calls Privy’s MFA screen or any unenroll method', () => {
    expect(filesMatching(/showMfaEnrollmentModal|unenrollWith(Totp|Sms|Passkey)|\bunenroll\s*\(/)).toEqual([]);
  });
});

describe('the embedded wallet signs and exports only from the listed modules (item 3)', () => {
  it('getEthereumProvider: the signer bridge, and the dev-only matrix harness', () => {
    expect(filesMatching(/\bgetEthereumProvider\s*\(/)).toEqual([
      'src/app/dev/privy-matrix/Harness.tsx', // dev pages only (devPagesAllowed; privy-matrix-gate.test.ts)
      'src/components/PrivyAuth.tsx', // EmbeddedSignerBridge: hands the provider to embedded-signer.ts
    ]);
  });

  it('personal_sign: the Safe operation signer, and the dev-only matrix harness', () => {
    expect(filesMatching(/['"]personal_sign['"]/)).toEqual([
      'src/app/dev/privy-matrix/Harness.tsx', // dev pages only
      'src/lib/embedded-signer.ts', // signSafeOpHash, the one Safe-operation signing boundary
    ]);
  });

  it('Privy exportWallet: the export action (fresh code first), and the dev-only matrix harness', () => {
    expect(filesMatching(/\bexportWallet\b/)).toEqual([
      'src/app/dev/privy-matrix/Harness.tsx', // dev pages only
      'src/components/PrivyAuth.tsx', // EmbeddedActionsProvider.exportKey: clears MFA, then exports
    ]);
  });

  it('Privy useSignMessage: only the sign-in proof', () => {
    const privySign = FILES.filter((f) => /import\s*\{[^}]*\buseSignMessage\b[^}]*\}\s*from\s*['"]@privy-io\/react-auth['"]/.test(f.text)).map((f) => f.path);
    expect(privySign).toEqual(['src/components/signin/PrivyEmailBridge.tsx']); // the proof message (privy-gated-signin.ts)
  });

  it('signTypedData: nowhere', () => {
    expect(filesMatching(/\bsignTypedData\b/)).toEqual([]);
  });

  it('wagmi useSignMessage stays on external wallets: SIWE sign-in, admin and the wallet prompt', () => {
    const wagmiSign = FILES.filter((f) => /import\s*\{[^}]*\buseSignMessage\b[^}]*\}\s*from\s*['"]wagmi['"]/.test(f.text)).map((f) => f.path).sort();
    expect(wagmiSign).toEqual([
      'src/components/AdminLogin.tsx',
      'src/components/profile/WalletSignInPrompt.tsx',
      'src/components/signin/SignInDialog.tsx',
    ]);
  });
});

describe('the wallet is created only after the server recorded the enrollment checkpoint (migration 0014)', () => {
  const dialog = code(readFileSync(join(SRC, 'components/signin/SignInDialog.tsx'), 'utf8'));
  /// The body of one handler, from its declaration to the next `const ... = async` handler.
  const handler = (name: string) => {
    const start = dialog.indexOf(`const ${name} = async`);
    expect(start, name).toBeGreaterThan(-1);
    const next = dialog.indexOf('= async', start + name.length + 20);
    return dialog.slice(start, next === -1 ? undefined : next);
  };
  it('every createWallet call in the dialog comes after confirmWalletFree in the same handler', () => {
    for (const name of ['finishEnroll', 'setupWallet']) {
      const body = handler(name);
      const cp = body.indexOf('confirmWalletFree(');
      const create = body.indexOf('gate.createWallet(');
      expect(cp, `${name} calls confirmWalletFree`).toBeGreaterThan(-1);
      expect(create, `${name} creates the wallet`).toBeGreaterThan(cp);
    }
    // And no other place in the app creates an embedded wallet.
    expect(filesMatching(/\.createWallet\s*\(|\bcreateWallet\s*\(\s*\)/)).toEqual([
      'src/app/dev/privy-matrix/Harness.tsx', // dev pages only (devPagesAllowed; privy-matrix-gate.test.ts)
      'src/components/signin/PrivyEmailBridge.tsx', // the bridge's createWallet, called only by the dialog's two handlers
      'src/components/signin/SignInDialog.tsx', // finishEnroll and setupWallet, each after confirmWalletFree
      'src/lib/privy-gated-signin.ts', // the GateBridge interface's declaration, not a call
    ]);
  });
});

describe('the Privy client configuration (src/components/PrivyAuth.tsx)', () => {
  const config = readFileSync(join(SRC, 'components/PrivyAuth.tsx'), 'utf8');
  const wallets = config.match(/embeddedWallets:\s*\{[^\n]*\}/)?.[0] ?? '';

  it('creates no wallet at login on either chain ([C5], [D1])', () => {
    expect(wallets).toMatch(/ethereum:\s*\{\s*createOnLogin:\s*'off'\s*\}/);
    expect(wallets).toMatch(/solana:\s*\{\s*createOnLogin:\s*'off'\s*\}/);
  });

  it("hides Privy's own sign/send pop-up: Mako's confirm sheet is the confirmation (live beta test 2026-10-07)", () => {
    expect(wallets).toMatch(/showWalletUIs:\s*false/);
  });
});
