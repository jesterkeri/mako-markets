import { CommonFields } from './CommonFields';
import { PmCreateFormState, PmCreateFormErrors, PmCreatePhase, PmCreateError } from '@/lib/private-markets/create-form';
import Link from 'next/link';

interface ShapeFormProps {
  state: PmCreateFormState;
  errors: PmCreateFormErrors;
  onChange: <K extends keyof PmCreateFormState>(key: K, value: PmCreateFormState[K]) => void;
  onSubmit: () => void;
  phase: PmCreatePhase;
  error: PmCreateError | null;
  drifted: boolean;
  signedIn: boolean;
}

export function FriendlyForm({ state, errors, onChange, onSubmit, phase, error, drifted, signedIn }: ShapeFormProps) {
  const hasErrors = Object.keys(errors).length > 0;
  const submitDisabled = !signedIn || drifted || hasErrors || (phase !== 'idle' && phase !== 'error');

  let buttonLabel = 'CREATE FRIENDLY MARKET';
  if (!signedIn) buttonLabel = 'SIGN IN TO CREATE';
  else if (phase === 'preparing') buttonLabel = 'PREPARING...';
  else if (phase === 'sponsoring') buttonLabel = 'SPONSORING USER OP...';
  else if (phase === 'wallet_drafting') buttonLabel = 'RESERVING SLUG...';
  else if (phase === 'wallet_simulating') buttonLabel = 'SIMULATING TX...';
  else if (phase === 'wallet_pending') buttonLabel = 'WAITING FOR CONFIRMATION...';
  else if (phase === 'success') buttonLabel = 'CREATED ✓';

  return (
    <div className="w-full flex flex-col lg:flex-row gap-8 lg:gap-12 mb-12 items-start">
      {/* EDITORIAL INFO BLOCK - NO BOXES */}
      <div className="w-full lg:w-[380px] shrink-0 flex flex-col order-1 lg:order-2 lg:sticky lg:top-24 mt-2 lg:mt-0">
        {/* Header - No Box */}
        <div className="mb-12">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-3 h-3 bg-mako-red rounded-full animate-pulse shadow-[0_0_8px_rgba(217,74,61,0.6)]"></div>
            <span className="font-mono text-xs tracking-[0.2em] uppercase opacity-60 text-canvas-fg">Market Spec</span>
          </div>
          <h2 className="font-display font-black text-6xl xl:text-7xl uppercase tracking-tighter leading-[0.85] mb-6 text-canvas-fg">
            Friendly<br/>Market
          </h2>
          <p className="font-sans font-medium text-lg text-canvas-fg/70 leading-relaxed border-l-4 border-mako-red pl-5 py-1">
            A classic zero-house-edge prediction market for you and your friends. Create custom outcomes, set stake limits, and bet against each other.
          </p>
        </div>

        {/* Steps - No Boxes */}
        <div className="flex flex-col gap-10">
          {[
            { title: "CUSTOM", desc: "Define the exact options people can bet on." },
            { title: "P2P BETS", desc: "Invite friends to stake USDC on their predictions." },
            { title: "ZERO FEES", desc: "Winning predictions split the pot. No platform fees." }
          ].map((step, i) => (
            <div key={i} className="flex items-start gap-6 group">
              <div className="text-6xl font-display font-black text-canvas-fg/10 group-hover:text-mako-red transition-colors select-none -mt-3">
                0{i + 1}
              </div>
              <div className="pt-1">
                <div className="font-display font-black text-2xl uppercase tracking-tight mb-2 text-canvas-fg group-hover:text-mako-red transition-colors">
                  {step.title}
                </div>
                <div className="font-sans text-base font-medium text-canvas-fg/60">
                  {step.desc}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="w-full flex-1 bg-paper border-2 border-ink rounded-2xl shadow-brutal overflow-hidden flex flex-col divide-y-2 divide-ink order-2 lg:order-1">
        <CommonFields state={state} errors={errors} onChange={onChange} />
      
      {/* OPTIONS */}
      <div className="px-6 py-5 bg-surface-elevated">
        <label className="mako-label text-muted mb-3 block">OPTIONS</label>
        <div className="grid grid-cols-2 gap-3">
          <div className="py-3 mako-label rounded-xl border-2 border-ink bg-paper text-ink shadow-brutal-sm text-center">NO</div>
          <div className="py-3 mako-label rounded-xl border-2 border-ink bg-paper text-ink shadow-brutal-sm text-center">YES</div>
        </div>
        <div className="mako-label text-subtle text-[10px] mt-3">LOCKED FOR FRIENDLY MARKETS.</div>
      </div>

      {/* STAKE LIMITS */}
      <div className="px-6 py-5">
        <label className="mako-label text-muted mb-3 block">STAKE LIMITS</label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col">
            <label className="mako-label text-muted mb-3">MIN STAKE (USDC)</label>
            <input
              type="number"
              step="0.01"
              value={state.perStakeMin}
              onChange={(e) => onChange('perStakeMin', e.target.value)}
              className={`w-full border-2 rounded-lg px-3 py-2 font-display font-bold text-base outline-none focus:border-accent bg-paper transition-colors ${
                errors.perStakeMin ? 'border-mako-red text-mako-red' : 'border-ink text-ink'
              }`}
            />
            <div className="mako-label text-subtle text-[10px] mt-2">OPTIONAL. ENTER 0 OR ≥ 0.01 USDC.</div>
            {errors.perStakeMin && <div className="text-mako-red mako-label mt-2">{errors.perStakeMin}</div>}
          </div>
          <div className="flex flex-col">
            <label className="mako-label text-muted mb-3">MAX STAKE (USDC)</label>
            <input
              type="number"
              step="0.01"
              value={state.perStakeMax}
              onChange={(e) => onChange('perStakeMax', e.target.value)}
              className={`w-full border-2 rounded-lg px-3 py-2 font-display font-bold text-base outline-none focus:border-accent bg-paper transition-colors ${
                errors.perStakeMax ? 'border-mako-red text-mako-red' : 'border-ink text-ink'
              }`}
            />
            <div className="mako-label text-subtle text-[10px] mt-2">OPTIONAL. ENTER 0 FOR NO MAX.</div>
            {errors.perStakeMax && <div className="text-mako-red mako-label mt-2">{errors.perStakeMax}</div>}
          </div>
        </div>
      </div>

      <div className="flex flex-col">
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitDisabled}
          className="w-full bg-signal hover:bg-signal/90 text-ink font-display font-black text-xl uppercase tracking-tight px-6 py-5 disabled:bg-muted disabled:text-paper disabled:cursor-not-allowed transition-colors"
        >
          {buttonLabel}
        </button>

        {error && (
          <div className="px-4 py-3 mako-label text-center border-t-2 border-ink bg-mako-red/15 text-mako-red">
            {error.draft ? (
              <div className="flex flex-col items-center gap-2">
                <div>YOUR DRAFT IS AT /M/{error.draft.slug} BUT THE TX DIDN'T LAND. RETRY?</div>
                <div className="flex justify-center gap-3 mt-2">
                  <Link href={`/m/${error.draft.slug}`} className="border-2 border-ink px-4 py-2 hover:bg-surface-elevated transition-colors bg-paper text-ink rounded-lg">
                    VIEW DRAFT
                  </Link>
                  <button
                    type="button"
                    onClick={onSubmit}
                    className="border-2 border-mako-red bg-mako-red text-paper px-4 py-2 hover:opacity-90 transition-colors rounded-lg"
                  >
                    RETRY
                  </button>
                </div>
              </div>
            ) : (
              error.message
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
