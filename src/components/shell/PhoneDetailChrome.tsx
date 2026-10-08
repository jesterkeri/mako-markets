'use client';

// Pool, round and chart pages draw their own phone header and bottom bar, so the shell hides its own on those routes
// (isMobileDetail). A page that replaces one of them (an error, a 404) has neither, so it wraps its phone layout in
// this: the shell's phone header, the content with the room every phone page leaves for the floating tab bar, and the
// tab bar (adversary on cb71ae1 and 449f085). On any other route the shell already shows them, so this adds nothing.
import { usePathname } from 'next/navigation';

import { isMobileDetail } from '@/lib/shell-nav';

import { MobileHeader } from './MobileHeader';
import { TabBar } from './TabBar';

export function PhoneDetailChrome({ children }: { children: React.ReactNode }) {
  if (!isMobileDetail(usePathname() ?? '')) return <>{children}</>;
  return (
    <>
      <MobileHeader />
      <div className="mk-main">{children}</div>
      <TabBar />
    </>
  );
}
