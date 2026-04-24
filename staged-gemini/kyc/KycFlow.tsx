import * as React from "react";

export type KycStep = "bvn_input" | "selfie_capture" | "verified" | "failed";

export interface KycFlowProps {
  currentStep: KycStep;
  onSubmitBvn: (bvn: string) => Promise<void>;
  onStartSelfie: () => void;
  onRetry: () => void;
  isLoading?: boolean;
}

const COPY = {
  heading: "Identity Verification",
  subheading: "Required to deposit Naira.",
  bvnLabel: "BANK VERIFICATION NUMBER (BVN)",
  bvnPlaceholder: "11-digit BVN",
  bvnSubmit: "SUBMIT BVN",
  selfieTitle: "Face Verification",
  selfieDesc: "We need a quick selfie to ensure you're a real person and match your BVN.",
  selfieAction: "START CAMERA",
  verifiedTitle: "Verified",
  verifiedDesc: "Your identity is confirmed. You can now deposit Naira.",
  failedTitle: "Verification Failed",
  failedDesc: "We couldn't verify your details. Please ensure your face is clearly visible and your BVN is correct.",
  retryAction: "TRY AGAIN",
  loading: "PROCESSING...",
};

export function KycFlow({ currentStep, onSubmitBvn, onStartSelfie, onRetry, isLoading = false }: KycFlowProps) {
  const [bvn, setBvn] = React.useState("");

  const handleBvnSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (bvn.length === 11 && !isLoading) {
      onSubmitBvn(bvn);
    }
  };

  return (
    <div className="w-full max-w-sm mx-auto px-4 py-8">
       <h1 className="mako-display text-3xl mb-2">{COPY.heading}</h1>
       <p className="mako-body text-muted mb-8">{COPY.subheading}</p>

       <div className="bg-paper border-2 border-ink p-6 rounded-2xl shadow-[4px_4px_0_0_#000000]">
         
         {currentStep === "bvn_input" && (
           <form onSubmit={handleBvnSubmit} className="flex flex-col gap-4">
             <label htmlFor="bvn" className="mako-label">{COPY.bvnLabel}</label>
             <input 
               id="bvn"
               type="text"
               value={bvn}
               onChange={e => setBvn(e.target.value.replace(/\D/g, '').slice(0, 11))}
               placeholder={COPY.bvnPlaceholder}
               className="w-full mako-mono text-xl border-2 border-ink rounded-lg p-3 bg-surface-elevated focus:bg-paper focus:outline-none focus:ring-2 focus:ring-signal"
               disabled={isLoading}
               required
             />
             <button 
               type="submit" 
               disabled={bvn.length !== 11 || isLoading}
               className="mako-button mako-button--signal w-full mt-4 disabled:opacity-50"
             >
               {isLoading ? COPY.loading : COPY.bvnSubmit}
             </button>
           </form>
         )}

         {currentStep === "selfie_capture" && (
           <div className="flex flex-col items-center text-center gap-4">
              <div className="w-32 h-32 rounded-full border-4 border-ink border-dashed bg-surface-elevated flex items-center justify-center mb-2">
                 <span className="mako-display text-4xl opacity-50">?</span>
              </div>
              <h3 className="mako-title text-xl">{COPY.selfieTitle}</h3>
              <p className="mako-body text-ink/80">{COPY.selfieDesc}</p>
              
              <button 
                onClick={onStartSelfie}
                disabled={isLoading}
                className="mako-button mako-button--signal w-full mt-4 disabled:opacity-50"
              >
                {isLoading ? COPY.loading : COPY.selfieAction}
              </button>
              {/* Claude: Smile Identity SDK wrapper mounts here */}
           </div>
         )}

         {currentStep === "verified" && (
           <div className="flex flex-col items-center text-center gap-4 py-4">
              <div className="w-16 h-16 rounded-full border-2 border-ink bg-signal flex items-center justify-center mb-2 shadow-[2px_2px_0_0_#000000]">
                <span className="mako-title text-2xl">✓</span>
              </div>
              <h3 className="mako-title text-xl">{COPY.verifiedTitle}</h3>
              <p className="mako-body text-muted">{COPY.verifiedDesc}</p>
           </div>
         )}

         {currentStep === "failed" && (
           <div className="flex flex-col items-center text-center gap-4 py-4 relative">
              <div className="w-16 h-16 rounded-full border-2 border-ink bg-mako-red flex items-center justify-center mb-2 shadow-[2px_2px_0_0_#000000] rotate-12">
                <span className="mako-title text-2xl text-paper">!</span>
              </div>
              <h3 className="mako-title text-xl">{COPY.failedTitle}</h3>
              <p className="mako-body text-ink">{COPY.failedDesc}</p>
              
              <button 
                onClick={onRetry}
                className="mako-button w-full mt-4 bg-surface-elevated text-ink"
              >
                {COPY.retryAction}
              </button>
           </div>
         )}
       </div>
    </div>
  );
}
