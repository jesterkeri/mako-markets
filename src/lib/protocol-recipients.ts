import { MAKO_ADDRESS, PM_CONTRACT_ADDRESS, ROUNDS_ADDRESS } from './contract';
import { USDC_ADDRESS } from './usdc';

// The addresses a USDC send is never allowed to reach: Mako Market's own contracts and the USDC contract. USDC sent
// to any of them cannot be returned. One list, imported by the gas sponsor's send validator
// (src/lib/aa-call-allowlist.ts, at sponsor time and at send time) and by the /wallet form
// (src/lib/use-wallet-send.ts), so the page and the server can never disagree (Codex batch r1 F1).
//
// This is not a block on contracts in general: every Mako Market email account is itself a contract (a Safe), so
// other contracts are allowed, and the page asks for an explicit acknowledgement before a send to one.

/// The configured protocol addresses, lowercased. Rounds is included once its address is configured.
export function protocolRecipients(): string[] {
  return [USDC_ADDRESS, MAKO_ADDRESS, PM_CONTRACT_ADDRESS, ROUNDS_ADDRESS]
    .filter((a): a is `0x${string}` => typeof a === 'string' && a.length > 0)
    .map((a) => a.trim().toLowerCase());
}

/// Whether a send to `recipient` must be refused as a Mako Market or USDC contract.
export function isProtocolRecipient(recipient: string): boolean {
  return protocolRecipients().includes(recipient.trim().toLowerCase());
}
