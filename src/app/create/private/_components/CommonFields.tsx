import { PmCreateFormState, PmCreateFormErrors, byteLength } from '@/lib/private-markets/create-form';
import { DateTimePicker } from '@/components/DateTimePicker';

interface CommonFieldsProps {
  state: PmCreateFormState;
  errors: PmCreateFormErrors;
  onChange: <K extends keyof PmCreateFormState>(key: K, value: PmCreateFormState[K]) => void;
}

/// Codex r2 MIN-1: show the user's resolved local timezone next to the
/// datetime pickers so it's unambiguous what timezone the typed value
/// is interpreted in. /m/[slug] displays UTC; this label closes the
/// loop. Falls back to a UTC-offset string if Intl.DateTimeFormat
/// can't resolve a named zone (very old browsers).
function getLocalTimezoneLabel(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch {
    /* fall through */
  }
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hh}:${mm}`;
}

export function CommonFields({ state, errors, onChange }: CommonFieldsProps) {
  const titleBytes = byteLength(state.title || '');
  const descBytes = byteLength(state.description || '');
  const urlBytes = byteLength(state.streamUrl || '');
  const allowlistCount = state.allowlist ? state.allowlist.length : 0;
  const tzLabel = getLocalTimezoneLabel();

  return (
    <>
      {/* TITLE */}
      <div className="px-6 py-5">
        <div className="flex justify-between items-baseline mb-3">
          <label className="mako-label text-muted">TITLE</label>
          <span className={`mako-label ${titleBytes > 100 ? 'text-mako-red' : 'text-muted'}`}>
            {titleBytes} / 100 BYTES
          </span>
        </div>
        <input
          type="text"
          value={state.title}
          onChange={(e) => onChange('title', e.target.value)}
          className={`w-full border-2 rounded-xl px-4 py-3 font-display font-bold text-xl outline-none focus:border-accent bg-paper transition-colors ${
            errors.title ? 'border-mako-red text-mako-red' : 'border-ink text-ink'
          }`}
        />
        {errors.title && <div className="text-mako-red mako-label mt-2">{errors.title}</div>}
      </div>

      {/* DESCRIPTION */}
      <div className="px-6 py-5">
        <div className="flex justify-between items-baseline mb-3">
          <label className="mako-label text-muted">DESCRIPTION</label>
          <span className={`mako-label ${descBytes > 2000 ? 'text-mako-red' : 'text-muted'}`}>
            {descBytes} / 2000 BYTES
          </span>
        </div>
        <textarea
          rows={4}
          value={state.description}
          onChange={(e) => onChange('description', e.target.value)}
          className={`w-full border-2 rounded-xl px-4 py-3 font-sans font-medium text-base outline-none focus:border-accent resize-none bg-paper transition-colors ${
            errors.description ? 'border-mako-red text-mako-red' : 'border-ink text-ink'
          }`}
        />
        {errors.description && <div className="text-mako-red mako-label mt-2">{errors.description}</div>}
      </div>

      {/* LIVESTREAM URL */}
      <div className="px-6 py-5">
        <div className="flex justify-between items-baseline mb-3">
          <label className="mako-label text-muted">LIVESTREAM URL (OPTIONAL)</label>
          <span className={`mako-label ${urlBytes > 256 ? 'text-mako-red' : 'text-muted'}`}>
            {urlBytes} / 256 BYTES
          </span>
        </div>
        <input
          type="url"
          value={state.streamUrl}
          onChange={(e) => onChange('streamUrl', e.target.value)}
          className={`w-full border-2 rounded-xl px-4 py-3 font-mono text-sm outline-none focus:border-accent bg-paper transition-colors ${
            errors.streamUrl ? 'border-mako-red text-mako-red' : 'border-ink text-ink'
          }`}
        />
        <div className="mako-label text-subtle text-[10px] mt-2">MUST START WITH HTTPS://</div>
        {errors.streamUrl && <div className="text-mako-red mako-label mt-2">{errors.streamUrl}</div>}
      </div>

      <div className="px-6 py-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* STAKING OPENS AT */}
        <div className="flex flex-col">
          <div className="flex justify-between items-baseline mb-3">
            <label className="mako-label text-muted">STAKING OPENS AT</label>
            {/* Codex r2 MIN-1: surface the user's tz so they know
                what zone they're typing in. /m/[slug] displays UTC. */}
            <span className="mako-label text-subtle text-[10px]">{tzLabel}</span>
          </div>
          <DateTimePicker
            value={state.stakingOpensAtIso}
            onChange={(next) => onChange('stakingOpensAtIso', next)}
            hasError={Boolean(errors.stakingOpensAtIso)}
          />
          <div className="mako-label text-subtle text-[10px] mt-2">WHEN BETS UNLOCK.</div>
          {errors.stakingOpensAtIso && <div className="text-mako-red mako-label mt-2">{errors.stakingOpensAtIso}</div>}
        </div>

        {/* CLOSES AT */}
        <div className="flex flex-col">
          <div className="flex justify-between items-baseline mb-3">
            <label className="mako-label text-muted">CLOSES AT</label>
            <span className="mako-label text-subtle text-[10px]">{tzLabel}</span>
          </div>
          <DateTimePicker
            value={state.closeAtIso}
            onChange={(next) => onChange('closeAtIso', next)}
            hasError={Boolean(errors.closeAtIso)}
          />
          <div className="mako-label text-subtle text-[10px] mt-2">AFTER THIS, RESOLUTION ONLY.</div>
          {errors.closeAtIso && <div className="text-mako-red mako-label mt-2">{errors.closeAtIso}</div>}
        </div>
      </div>

      {/* VIEW */}
      <div className="px-6 py-5">
        <label className="mako-label text-muted mb-3 block">VIEW</label>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => onChange('viewMode', 'link_only')}
            className={`py-3 mako-label rounded-xl border-2 border-ink transition-all ${
              state.viewMode === 'link_only'
                ? 'bg-ink text-paper shadow-brutal-red -translate-y-[2px] -translate-x-[2px]'
                : 'bg-paper shadow-brutal-sm hover:-translate-y-[1px] hover:-translate-x-[1px]'
            }`}
          >
            LINK ONLY
          </button>
          <button
            type="button"
            onClick={() => onChange('viewMode', 'public')}
            className={`py-3 mako-label rounded-xl border-2 border-ink transition-all ${
              state.viewMode === 'public'
                ? 'bg-ink text-paper shadow-brutal-red -translate-y-[2px] -translate-x-[2px]'
                : 'bg-paper shadow-brutal-sm hover:-translate-y-[1px] hover:-translate-x-[1px]'
            }`}
          >
            PUBLIC
          </button>
        </div>
        <div className="mako-label text-subtle text-[10px] mt-3">
          LINK ONLY MARKETS ARE NOT LISTED. SHARE THE URL.
        </div>
      </div>

      {/* PARTICIPATION */}
      <div className="px-6 py-5">
        <label className="mako-label text-muted mb-3 block">PARTICIPATION</label>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => onChange('participationMode', 'open')}
            className={`py-3 mako-label rounded-xl border-2 border-ink transition-all ${
              state.participationMode === 'open'
                ? 'bg-ink text-paper shadow-brutal-red -translate-y-[2px] -translate-x-[2px]'
                : 'bg-paper shadow-brutal-sm hover:-translate-y-[1px] hover:-translate-x-[1px]'
            }`}
          >
            OPEN
          </button>
          <button
            type="button"
            onClick={() => onChange('participationMode', 'allowlisted')}
            className={`py-3 mako-label rounded-xl border-2 border-ink transition-all ${
              state.participationMode === 'allowlisted'
                ? 'bg-ink text-paper shadow-brutal-red -translate-y-[2px] -translate-x-[2px]'
                : 'bg-paper shadow-brutal-sm hover:-translate-y-[1px] hover:-translate-x-[1px]'
            }`}
          >
            ALLOWLISTED
          </button>
        </div>
        <div className="mako-label text-subtle text-[10px] mt-3">
          ALLOWLISTED LIMITS WHO CAN STAKE.
        </div>
      </div>

      {/* ALLOWLIST */}
      {state.participationMode === 'allowlisted' && (
        <div className="px-6 py-5">
          <div className="flex justify-between items-baseline mb-3">
            <label className="mako-label text-muted">ALLOWLIST</label>
            <span className={`mako-label ${allowlistCount > 100 ? 'text-mako-red' : 'text-muted'}`}>
              {allowlistCount} / 100 ADDRESSES
            </span>
          </div>
          <textarea
            rows={6}
            value={state.allowlist.join('\n')}
            onChange={(e) => {
              const lines = e.target.value.split('\n');
              onChange('allowlist', lines);
            }}
            className={`w-full border-2 rounded-xl px-4 py-3 font-mono text-xs outline-none focus:border-accent resize-none bg-paper transition-colors ${
              errors.allowlist ? 'border-mako-red text-mako-red' : 'border-ink text-ink'
            }`}
          />
          <div className="mako-label text-subtle text-[10px] mt-2">
            ONE 0X-ADDRESS PER LINE. NO DUPLICATES.
          </div>
          {errors.allowlist && <div className="text-mako-red mako-label mt-2">{errors.allowlist}</div>}
        </div>
      )}
    </>
  );
}
