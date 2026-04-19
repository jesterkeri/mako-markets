import { cookies } from 'next/headers';
import {
  NONCE_COOKIE,
  NONCE_MAX_AGE_SEC,
  newNonce,
  signNonceToken,
} from '@/lib/admin-session';

export async function GET() {
  const nonce = newNonce();
  const store = await cookies();
  store.set(NONCE_COOKIE, signNonceToken(nonce), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: NONCE_MAX_AGE_SEC,
  });
  return Response.json({ nonce });
}
