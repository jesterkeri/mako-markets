'use client';

import { RoundView, type View } from '@/app/rounds/[id]/RoundClient';
import { RoundSections } from '@/app/rounds/RoundsClient';
import { positionOf, RefundReason, RoundOutcome, RoundStatus, phaseAt, pendingRefund, type Round } from '@/lib/rounds-model';
import { useLiveNowSec } from '@/lib/use-live-clock';

// Sample rounds for the dev preview only: clearly fake, never shown outside /dev.
const U = 1_000_000n;
const P = 10n ** 18n;

function sample(now: number): Round[] {
  const minute = Math.floor(now / 60) * 60;
  const base = (id: number, start: number, over: Partial<Round>): Round => ({
    id: BigInt(id),
    creator: '0x1111111111111111111111111111111111111111',
    openTime: start - 7200,
    startTime: start,
    status: RoundStatus.Active,
    outcome: RoundOutcome.None,
    refundReason: RefundReason.None,
    anchorPrice: 0n,
    closePrice: 0n,
    upPool: 0n,
    downPool: 0n,
    upEntrants: 0,
    downEntrants: 0,
    protocolFee: 0n,
    creatorFee: 0n,
    distributable: 0n,
    ...over,
  });
  return [
    base(14, minute + 7200 + 300, { upPool: 12n * U, downPool: 0n, upEntrants: 2 }),
    base(13, minute + 1500, { upPool: 62n * U, downPool: 38n * U, upEntrants: 9, downEntrants: 5 }),
    base(12, minute - 300, { upPool: 41n * U, downPool: 55n * U, upEntrants: 6, downEntrants: 8 }),
    base(11, minute - 7200, {
      status: RoundStatus.Settled,
      outcome: RoundOutcome.Up,
      anchorPrice: 62_140n * P,
      closePrice: 62_188n * P,
      upPool: 60n * U,
      downPool: 40n * U,
      upEntrants: 7,
      downEntrants: 4,
      protocolFee: 1n * U,
      creatorFee: 800_000n,
      distributable: 98_200_000n,
    }),
    base(10, minute - 14400, { status: RoundStatus.Refunded, refundReason: RefundReason.Tie, upPool: 20n * U, downPool: 20n * U, upEntrants: 3, downEntrants: 3 }),
  ];
}

const noop = () => {};

export function RoundsPreview({ view }: { view: string }) {
  const now = useLiveNowSec();
  if (now === null) return null;
  const rounds = sample(now);
  if (view === 'list') {
    return (
      <>
        <div className="mk-desk mk-desk-frame">
          <h1 style={{ margin: '22px 0 20px', fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 56 }}>Rounds</h1>
          <RoundSections rounds={rounds} now={now} narrow={false} />
        </div>
        <div className="mk-mob mk-m">
          <div style={{ padding: '0 20px' }}>
            <h1 style={{ margin: '14px 0', fontFamily: 'var(--mako-font-display)', fontWeight: 800, fontSize: 40 }}>Rounds</h1>
            <RoundSections rounds={rounds} now={now} narrow />
          </div>
        </div>
      </>
    );
  }
  const pick = view === 'live' ? rounds[2] : view === 'settled' ? rounds[3] : view === 'refund' ? rounds[4] : rounds[1];
  const stake = view === 'settled' ? { side: 'up' as const, amount: 30n * U } : view === 'live' ? { side: 'down' as const, amount: 10n * U } : { side: null, amount: 0n };
  const v: View = {
    round: pick,
    phase: phaseAt(pick, now),
    now,
    position: positionOf(pick, stake, false, now),
    signedIn: true,
    balance: 250n * U,
    side: stake.side ?? 'up',
    sideLocked: stake.side !== null,
    setSide: noop,
    amountText: '5',
    setAmountText: noop,
    amount: 5n * U,
    estimate: 8_093_000n,
    why: null,
    openEnter: noop,
    claimAmount: view === 'settled' ? 49_100_000n : 0n,
    creatorFeeDue: null,
    openClaim: noop,
    refundToMark: pendingRefund(pick, now),
    openMarkRefund: noop,
  };
  return (
    <>
      <div className="mk-desk mk-desk-frame">
        <RoundView {...v} narrow={false} />
      </div>
      <div className="mk-mob mk-m">
        <RoundView {...v} narrow />
      </div>
    </>
  );
}
