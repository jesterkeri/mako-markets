import * as React from "react";

export interface AllowlistRejectionProps {
  email: string;
}

const COPY = {
  heading: "Not invited yet.",
  body: "Mako is currently in private beta. We'll send an invite to ",
  bodySuffix: " when a spot opens up.",
  backButton: "USE DIFFERENT EMAIL",
};

export function AllowlistRejection({ email }: AllowlistRejectionProps) {
  return (
    <div className="flex flex-col items-center justify-center w-full max-w-sm mx-auto text-center">
      <div className="rotate-2 transform mb-8">
        <div className="bg-paper border-2 border-ink rounded-2xl shadow-[6px_6px_0_0_#000000] p-6 text-left relative overflow-hidden">
          
          {/* Tape deco */}
          <div className="absolute -top-3 -right-3 w-12 h-6 bg-surface-elevated rotate-45 border-b-2 border-ink" />

          <h1 className="mako-title text-3xl mb-4">{COPY.heading}</h1>
          <p className="mako-body text-muted">
            {COPY.body}
            <strong className="text-ink">{email}</strong>
            {COPY.bodySuffix}
          </p>
        </div>
      </div>

      <button 
        className="mako-label text-muted hover:text-ink underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink pt-2"
        type="button"
      >
        {COPY.backButton}
      </button>
    </div>
  );
}
