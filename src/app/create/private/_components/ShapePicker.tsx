import type { PmShape } from '@/lib/private-markets/create-form';
import { MarketTypePicker } from '@/components/MarketTypePicker';

// ----------------------------------------------------------------------------
// ShapePicker — thin adapter over the shared MarketTypePicker. The
// shared picker is generic in its key type; this wrapper pins the
// shape union, supplies the per-shape labels + descriptions + accent
// fills, and presents the same API the page wired against earlier
// (selected: PmShape | null, onSelect: (PmShape | null) => void).
//
// `onSelect(null)` is accepted at the page level (used by a future
// "clear selection" affordance) but the underlying MarketTypePicker
// only ever calls onSelect(key) — there is no clear button today.
// ----------------------------------------------------------------------------

interface ShapePickerProps {
  selected: PmShape | null;
  onSelect: (shape: PmShape | null) => void;
}

export function ShapePicker({ selected, onSelect }: ShapePickerProps) {
  return (
    <MarketTypePicker<PmShape>
      selected={selected}
      onSelect={(k) => onSelect(k)}
      className="mb-8"
      options={[
        {
          key: 'friendly',
          label: 'FRIENDLY',
          description: 'TWO-SIDED PREDICTION. NO / YES.',
          activeClass: 'bg-mako-red text-paper',
        },
        {
          key: 'open_vote',
          label: 'OPEN VOTE',
          description: 'MULTI-OPTION VOTE. FIXED STAKE PER VOTE.',
          activeClass: 'bg-signal text-ink',
        },
        {
          key: 'prize_pool',
          label: 'PRIZE POOL',
          description: 'PARTICIPANTS COMPETE. WINNERS SHARE POT.',
          activeClass: 'bg-ink text-paper',
        },
      ]}
    />
  );
}
