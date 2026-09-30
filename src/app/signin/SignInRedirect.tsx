'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { openSignIn } from '@/lib/sign-in-store';

export function SignInRedirect() {
  const router = useRouter();
  useEffect(() => {
    openSignIn();
    router.replace('/pools');
  }, [router]);
  return null;
}
