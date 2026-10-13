// Adversary pass on 624326a (sign-in scroll lock). The sign-in dialog locks the page through usePageScrollLock
// (DesktopDialog and MobileSheet each call it). Other modals, here the real BroadcastQrModal, save and restore
// document.body.style.overflow on their own. Spec point 3: no interference, open and close in either order.
import { render, renderHook } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BroadcastQrModal } from '@/components/BroadcastQrModal';
import { usePageScrollLock } from '@/lib/use-page-scroll-lock';

vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));

// Mirrors how SignInDialog mounts the hook: both layouts are always mounted, CSS hides one.
function SignInLayers() {
  return (
    <>
      <DesktopLayer />
      <MobileLayer />
    </>
  );
}
function DesktopLayer() {
  usePageScrollLock();
  return null;
}
function MobileLayer() {
  usePageScrollLock();
  return null;
}

function Qr({ open }: { open: boolean }) {
  return <BroadcastQrModal open={open} onClose={() => {}} marketId={1n} question="q" bettingCloseTimeSec={0n} />;
}

afterEach(() => {
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
});

describe('adversary 624326a: sign-in lock vs another modal that sets body overflow', () => {
  it('QR modal opens, sign-in opens, QR closes, sign-in closes: page scrolls again', () => {
    const qr = render(<Qr open />);
    const signIn = render(<SignInLayers />);
    qr.rerender(<Qr open={false} />);
    signIn.unmount();
    qr.unmount();
    expect(document.body.style.overflow).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('sign-in opens, QR modal opens, sign-in closes, QR closes: page scrolls again', () => {
    const signIn = render(<SignInLayers />);
    const qr = render(<Qr open />);
    signIn.unmount();
    qr.rerender(<Qr open={false} />);
    qr.unmount();
    expect(document.body.style.overflow).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('sign-in opens, QR modal opens, sign-in closes: page stays locked while the QR modal is still open', () => {
    const signIn = render(<SignInLayers />);
    const qr = render(<Qr open />);
    signIn.unmount();
    expect(document.body.style.overflow).toBe('hidden');
    qr.unmount();
  });
});

describe('adversary 624326a: StrictMode and toggling', () => {
  it('StrictMode double mount leaves no stuck lock', () => {
    const r = render(
      <React.StrictMode>
        <SignInLayers />
      </React.StrictMode>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    r.unmount();
    expect(document.body.style.overflow).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('active flipping true/false/true then unmount restores', () => {
    document.body.style.overflow = 'auto';
    const h = renderHook(({ a }) => usePageScrollLock(a), { initialProps: { a: true } });
    h.rerender({ a: false });
    expect(document.body.style.overflow).toBe('auto');
    h.rerender({ a: true });
    h.unmount();
    expect(document.body.style.overflow).toBe('auto');
  });
});
