'use client';

import Link from 'next/link';

import { SIGN_IN_HREF } from '@/lib/shell-nav';
import { openSignIn } from '@/lib/sign-in-store';

/// "Sign in": opens the sign-in dialog over the current page. It stays a real link to /signin, so opening it in a
/// new tab or without JavaScript still works.
export function SignInLink({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <Link
      href={SIGN_IN_HREF}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        openSignIn();
      }}
      className={className}
      style={style}
    >
      {children}
    </Link>
  );
}
