import * as React from "react";

const COPY = {
  heading: "Security & Recovery",
  warningLevel: "WAIT, READ THIS",
  bodyText1: "Mako uses Magic.link to secure your embedded wallet.",
  bodyText2: "If someone gains access to your email, they gain access to your money. Secure your email account with 2FA.",
  exportAction: "EXPORT PRIVATE KEY",
  exportWarning: "Never share exported keys.",
};

export function RecoverySection() {
  const handleExport = () => {
    // Claude: Wire to Magic SDK export flow
    console.log("Exporting key");
  };

  return (
    <section className="w-full mt-8 bg-paper border-2 border-ink p-6 rounded-2xl shadow-[4px_4px_0_0_#000000]">
      <h3 className="mako-title text-xl mb-4">{COPY.heading}</h3>
      
      <div className="bg-mako-red text-paper p-4 rounded-xl border-2 border-ink -rotate-1 transform mb-6">
        <h4 className="mako-label mb-2">{COPY.warningLevel}</h4>
        <p className="mako-body text-sm mb-2">{COPY.bodyText1}</p>
        <p className="mako-body text-sm font-bold">{COPY.bodyText2}</p>
      </div>

      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 border-t-2 border-ink border-dashed pt-4">
        <span className="mako-label text-muted text-xs">{COPY.exportWarning}</span>
        <button 
          onClick={handleExport}
          className="mako-button w-full sm:w-auto bg-surface-elevated text-ink"
        >
          {COPY.exportAction}
        </button>
      </div>
    </section>
  );
}
