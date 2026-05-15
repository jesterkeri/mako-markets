'use client';

import { useState } from 'react';

export function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={`border-2 border-ink rounded-xl px-3 py-1 font-bold uppercase text-sm transition-colors ${
        copied ? 'bg-signal text-ink' : 'bg-paper text-ink hover:bg-surface-elevated'
      }`}
    >
      {copied ? 'COPIED' : 'COPY LINK'}
    </button>
  );
}
