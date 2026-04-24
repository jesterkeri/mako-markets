import * as React from "react";

export interface CreateMarketFormProps {
  onSubmit: (data: { question: string, category: string, closeTime: string }) => Promise<void>;
  isLoading?: boolean;
}

const COPY = {
  heading: "Create Market",
  questionLabel: "WHAT'S THE QUESTION?",
  questionPlaceholder: "e.g. Will $MON token launch before Q3 2024?",
  categoryLabel: "CATEGORY",
  closeLabel: "MARKET CLOSES IN",
  createAction: "CREATE MARKET",
  loading: "CREATING...",
};

const CATEGORIES = ["CRYPTO", "FOOTBALL", "NBA", "CULTURE"];
const CLOSE_TIMES = [
  { label: "1h", value: "1h" },
  { label: "24h", value: "24h" },
  { label: "3d", value: "3d" },
  { label: "7d", value: "7d" },
];

export function CreateMarketForm({ onSubmit, isLoading = false }: CreateMarketFormProps) {
  const [question, setQuestion] = React.useState("");
  const [category, setCategory] = React.useState("CRYPTO");
  const [closeTime, setCloseTime] = React.useState("24h");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question || !category || !closeTime) return;
    await onSubmit({ question, category, closeTime });
  };

  return (
    <div className="w-full max-w-xl mx-auto px-4 py-8">
      <h1 className="mako-display text-4xl mb-8">{COPY.heading}</h1>

      <form onSubmit={handleSubmit} className="flex flex-col gap-8 bg-paper border-2 border-ink p-6 sm:p-8 rounded-2xl shadow-[6px_6px_0_0_#000000]">
        
        {/* Question Area */}
        <div className="flex flex-col gap-2">
           <label htmlFor="question-input" className="mako-label">{COPY.questionLabel}</label>
           <textarea 
             id="question-input"
             value={question}
             onChange={e => setQuestion(e.target.value)}
             placeholder={COPY.questionPlaceholder}
             className="w-full bg-surface-elevated border-2 border-ink rounded-xl p-4 mako-title text-2xl placeholder:opacity-50 focus:outline-none focus:ring-2 focus:ring-signal focus:bg-paper resize-none min-h-[120px]"
             disabled={isLoading}
             required
           />
        </div>

        {/* Category Group */}
        <div className="flex flex-col gap-2">
          <span className="mako-label">{COPY.categoryLabel}</span>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                disabled={isLoading}
                className={`mako-label px-4 py-2 border-2 border-ink rounded-lg transition-all
                  ${category === cat 
                    ? "bg-ink text-paper shadow-[2px_2px_0_0_#D94A3D]" 
                    : "bg-surface-elevated text-ink hover:bg-paper shadow-[2px_2px_0_0_#000000]"}
                `}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Close Time Chips */}
        <div className="flex flex-col gap-2">
          <span className="mako-label">{COPY.closeLabel}</span>
          <div className="flex gap-2">
             {CLOSE_TIMES.map(time => (
               <button
                 key={time.value}
                 type="button"
                 onClick={() => setCloseTime(time.value)}
                 disabled={isLoading}
                 className={`mako-mono text-base px-3 py-1 border-2 border-ink rounded-full transition-all
                   ${closeTime === time.value
                      ? "bg-signal text-ink shadow-[2px_2px_0_0_#000000]"
                      : "bg-surface-elevated text-muted hover:bg-paper hover:text-ink shadow-[2px_2px_0_0_#000000]"}
                 `}
               >
                 {time.label}
               </button>
             ))}
          </div>
        </div>

        <button 
          type="submit"
          disabled={isLoading || !question}
          className="mako-button mako-button--signal w-full mt-4"
        >
          {isLoading ? COPY.loading : COPY.createAction}
        </button>
      </form>
    </div>
  );
}
