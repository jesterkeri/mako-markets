// ----------------------------------------------------------------------------
// src/components/MarketTypePicker.tsx
//
// Tilted-cards picker. Used by both /create (CRYPTO / FOOTBALL / NBA)
// and /create/private (FRIENDLY / OPEN VOTE / PRIZE POOL). Generic in
// the key type — consumers parameterise with their own union.
//
// Visual model:
//   - Three large cards, each rotated -3° / +1° / +3° in resting state.
//   - Every card is ALWAYS filled with its `activeClass` brand fill
//     (red / signal / ink) so the picker uses the wider Mako palette
//     on first paint, not just on selection.
//   - When a selection lands, the picked card straightens (0°), scales
//     up, gets the heavy shadow + z-lift. Other cards fade to ~55%
//     opacity so the active one reads clearly without a competing
//     full-color sibling.
//   - Hover on an unselected card straightens + lifts it; encourages
//     exploration without committing.
//
// Joshua picked this from a 3-variant Gemini round (tilted vs index
// tabs vs offset stack). Direction is consistent with the existing
// brutalist body: heavy borders, hard offset shadows, ALL CAPS labels.
// ----------------------------------------------------------------------------

export interface PickerOption<K extends string = string> {
  key: K;
  label: string;
  description: string;
  /// Brand-token classes for the card fill, e.g. 'bg-mako-red text-paper'.
  /// Always applied (the resting state is colored too, not cream).
  activeClass: string;
}

export interface MarketTypePickerProps<K extends string = string> {
  options: ReadonlyArray<PickerOption<K>>;
  selected: K | null;
  onSelect: (key: K) => void;
  disabled?: boolean;
  className?: string;
}

const TILTS = ['-rotate-3', 'rotate-1', 'rotate-3'] as const;

export function MarketTypePicker<K extends string>({
  options,
  selected,
  onSelect,
  disabled,
  className = '',
}: MarketTypePickerProps<K>): React.ReactElement {
  return (
    <div
      className={`grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-6 py-4 ${className}`}
    >
      {options.map((opt, i) => {
        const isActive = selected === opt.key;
        const noneSelected = selected === null;
        const tilt = TILTS[i % TILTS.length];

        // Always start with the card's brand fill, heavy border, and
        // rounded-3xl corners. Selection state layers transforms on
        // top.
        let cls =
          'min-h-[180px] sm:min-h-[220px] rounded-3xl border-2 border-ink p-6 sm:p-8 ' +
          'flex flex-col justify-between text-left ' +
          'transition-all duration-200 ease-out cursor-pointer ' +
          'disabled:opacity-40 disabled:cursor-not-allowed ' +
          `${opt.activeClass} `;

        if (isActive) {
          // Picked: straight, scaled, heavy shadow, on top.
          cls +=
            'rotate-0 scale-[1.04] shadow-brutal-lg z-10 ' +
            '-translate-y-1 ';
        } else if (noneSelected) {
          // Idle (nothing picked yet): tilted, regular shadow,
          // hover-lift to invite a tap.
          cls +=
            `${tilt} shadow-brutal ` +
            'hover:rotate-0 hover:-translate-y-1 hover:shadow-brutal-lg ';
        } else {
          // Another card is picked: dim this one so the active one
          // reads loud. Hover restores full opacity for re-selection.
          cls +=
            `${tilt} shadow-brutal opacity-55 ` +
            'hover:opacity-100 hover:rotate-0 hover:-translate-y-1 hover:shadow-brutal-lg ';
        }

        return (
          <button
            key={opt.key}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(opt.key)}
            aria-pressed={isActive}
            className={cls}
          >
            <div className="font-display font-bold text-2xl sm:text-3xl uppercase leading-tight">
              {opt.label}
            </div>
            <div className="font-bold text-sm uppercase leading-snug mt-4">
              {opt.description}
            </div>
          </button>
        );
      })}
    </div>
  );
}
