import { CommonFields } from './CommonFields';
import { PmCreateFormState, PmCreateFormErrors, PmCreatePhase, PmCreateError, byteLength } from '@/lib/private-markets/create-form';
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
  /// Codex r2 MAJ-2: external blocker (e.g. treasury fetch loading or
  /// errored). When true, the submit button is disabled and the label
  /// reflects the blocker so the user understands why submit is gated.
  submitBlocked?: boolean;
  submitBlockedReason?: string | null;
}

export function OpenVoteForm({ state, errors, onChange, onSubmit, phase, error, drifted, signedIn, submitBlocked, submitBlockedReason }: ShapeFormProps) {
  const hasErrors = Object.keys(errors).length > 0;
  const submitDisabled = !signedIn || drifted || hasErrors || (phase !== 'idle' && phase !== 'error') || Boolean(submitBlocked);

  let buttonLabel = 'CREATE OPEN VOTE MARKET';
  if (!signedIn) buttonLabel = 'SIGN IN TO CREATE';
  else if (submitBlocked && submitBlockedReason) buttonLabel = submitBlockedReason;
  else if (phase === 'preparing') buttonLabel = 'PREPARING...';
  else if (phase === 'sponsoring') buttonLabel = 'SPONSORING USER OP...';
  else if (phase === 'wallet_drafting') buttonLabel = 'RESERVING SLUG...';
  else if (phase === 'wallet_simulating') buttonLabel = 'SIMULATING TX...';
  else if (phase === 'wallet_pending') buttonLabel = 'WAITING FOR CONFIRMATION...';
  else if (phase === 'success') buttonLabel = 'CREATED ✓';

  const addOption = () => {
    if (state.optionLabels.length < 50) {
      onChange('optionLabels', [...state.optionLabels, '']);
    }
  };

  const removeOption = (index: number) => {
    const newLabels = [...state.optionLabels];
    newLabels.splice(index, 1);
    onChange('optionLabels', newLabels);
  };

  const updateOption = (index: number, val: string) => {
    const newLabels = [...state.optionLabels];
    newLabels[index] = val;
    onChange('optionLabels', newLabels);
  };

  return (
    <div className="w-full flex flex-col lg:flex-row gap-8 lg:gap-12 mb-12 items-start">
      {/* EDITORIAL INFO BLOCK - NO BOXES */}
      <div className="w-full lg:w-[380px] shrink-0 flex flex-col order-1 lg:order-2 lg:sticky lg:top-24 mt-2 lg:mt-0">
        {/* Header - No Box */}
        <div className="mb-12">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-3 h-3 bg-mako-red rounded-full animate-pulse shadow-mako-pulse"></div>
            <span className="font-mono text-xs tracking-[0.2em] uppercase opacity-60 text-canvas-fg">Market Spec</span>
          </div>
          <h2 className="font-display font-black text-6xl xl:text-7xl uppercase tracking-tighter leading-[0.85] mb-6 text-canvas-fg">
            Open<br/>Vote
          </h2>
          <p className="font-sans font-medium text-lg text-canvas-fg/70 leading-relaxed border-l-4 border-mako-red pl-5 py-1">
            A decentralized, fixed-stake poll. Every voter pays the exact same entry fee to cast their vote. The options that receive the most votes win.
          </p>
        </div>

        {/* Steps - No Boxes */}
        <div className="flex flex-col gap-10">
          {[
            { title: "FIXED ENTRY", desc: "Set a mandatory USDC stake required to cast a vote." },
            { title: "OPEN VOTING", desc: "Anyone can vote for their preferred option." },
            { title: "SPLIT POT", desc: "The winning options split the total pot." }
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
      <div className="px-6 py-5 flex flex-col gap-4">
        <div className="flex justify-between items-baseline mb-1">
          <label className="mako-label text-muted block">OPTIONS</label>
          <span className={`mako-label ${state.optionLabels.length > 50 ? 'text-mako-red' : 'text-muted'}`}>
            {state.optionLabels.length} / 50 OPTIONS
          </span>
        </div>
        {state.optionLabels.map((label, idx) => {
          const bytes = byteLength(label);
          return (
            <div key={idx} className="flex items-stretch border-2 border-ink rounded-xl bg-paper overflow-hidden">
              <div className="flex-1 flex flex-col relative border-r-2 border-ink">
                <div className="absolute left-4 top-1/2 -translate-y-1/2 font-display font-black text-ink/30 pointer-events-none select-none">
                  {idx + 1}
                </div>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => updateOption(idx, e.target.value)}
                  placeholder="OPTION LABEL"
                  className={`w-full h-full min-h-[56px] pl-10 pr-4 py-3 font-display font-bold text-lg outline-none bg-transparent ${
                    bytes > 80 ? 'text-mako-red' : 'text-ink'
                  }`}
                />
                {bytes > 80 && (
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 text-mako-red text-[10px] font-bold bg-paper px-1">
                    TOO LONG
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => removeOption(idx)}
                disabled={state.optionLabels.length <= 2}
                className="w-[56px] min-h-[56px] flex items-center justify-center bg-surface-elevated hover:bg-mako-red hover:text-paper transition-colors font-bold text-2xl disabled:opacity-50 disabled:cursor-not-allowed shrink-0 text-ink"
                aria-label="Remove option"
              >
                ×
              </button>
            </div>
          );
        })}
        {errors.optionLabels && <div className="bg-mako-red/15 text-mako-red border-2 border-mako-red px-4 py-3 rounded-xl mako-label mt-2">{errors.optionLabels}</div>}

        <button
          type="button"
          onClick={addOption}
          disabled={state.optionLabels.length >= 50}
          className="w-full border-2 rounded-xl border-ink border-dashed py-4 mako-label text-ink hover:bg-surface-elevated transition-colors disabled:opacity-50 bg-paper/50"
        >
          + ADD OPTION
        </button>
      </div>

      <div className="px-6 py-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col">
          <label className="mako-label text-muted mb-3">FIXED STAKE PER VOTE (USDC)</label>
          <input
            type="number"
            step="0.01"
            value={state.fixedStake}
            onChange={(e) => onChange('fixedStake', e.target.value)}
            className={`w-full border-2 rounded-lg px-3 py-2 font-display font-bold text-base outline-none focus:border-accent bg-paper transition-colors ${
              errors.fixedStake ? 'border-mako-red text-mako-red' : 'border-ink text-ink'
            }`}
          />
          <div className="mako-label text-subtle text-[10px] mt-2">EVERY VOTE PAYS THIS EXACT AMOUNT. MIN 0.01 USDC.</div>
          {errors.fixedStake && <div className="text-mako-red mako-label mt-2">{errors.fixedStake}</div>}
        </div>

        <div className="flex flex-col">
          <label className="mako-label text-muted mb-3">TOP N WINNERS</label>
          <input
            type="number"
            min="1"
            max={Math.min(Math.max(state.optionLabels.length, 1), 10)}
            value={state.winnersCount}
            onChange={(e) => onChange('winnersCount', parseInt(e.target.value, 10))}
            className={`w-full border-2 rounded-lg px-3 py-2 font-display font-bold text-base outline-none focus:border-accent bg-paper transition-colors ${
              errors.winnersCount ? 'border-mako-red text-mako-red' : 'border-ink text-ink'
            }`}
          />
          <div className="mako-label text-subtle text-[10px] mt-2">HOW MANY OPTIONS WIN.</div>
          {errors.winnersCount && <div className="text-mako-red mako-label mt-2">{errors.winnersCount}</div>}
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
