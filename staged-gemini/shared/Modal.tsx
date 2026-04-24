import * as React from "react";

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

const COPY = {
  close: "CLOSE",
};

export function Modal({ isOpen, onClose, title, children }: ModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 backdrop-blur-sm p-4">
      {/* Neobrutalist overlay backdrop implies no blur ideally, but simple tint works. The prompt says "no blur, no gradients" for *shadows*, wait. Let's use pure black with opacity for backdrop */}
      <div 
        className="fixed inset-0 bg-ink/40" 
        onClick={onClose}
        aria-hidden="true"
      />
      
      {/* Modal Card */}
      <div 
        className="relative z-10 w-full max-w-md bg-paper border-2 border-ink rounded-lg shadow-[4px_4px_0_0_#000000] flex flex-col max-h-[90vh]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div className="flex items-center justify-between p-4 border-b-2 border-ink bg-surface-elevated rounded-t-[10px]">
          <h2 id="modal-title" className="mako-title text-xl">{title}</h2>
          <button 
            onClick={onClose}
            className="mako-label hover:text-mako-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal rounded"
            aria-label={COPY.close}
          >
            {COPY.close}
          </button>
        </div>
        
        <div className="p-6 overflow-y-auto mako-body">
          {children}
        </div>
      </div>
    </div>
  );
}
