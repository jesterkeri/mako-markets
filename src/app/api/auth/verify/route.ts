import { cookies } from 'next/headers';
import { SiweMessage } from 'siwe';
import { ADMIN_ADDRESS } from '@/lib/admin-address';
import { monadTestnet } from '@/lib/chain';
import {
  NONCE_COOKIE,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  signSessionToken,
  verifyNonceToken,
} from '@/lib/admin-session';

export async function POST(req: Request) {
  let body: { message?: string; signature?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  if (typeof body.message !== 'string' || typeof body.signature !== 'string') {
    return Response.json({ error: 'bad_body' }, { status: 400 });
  }

  const store = await cookies();
  const nonceToken = store.get(NONCE_COOKIE)?.value;
  if (!nonceToken) return Response.json({ error: 'no_nonce' }, { status: 400 });
  const nonceParsed = verifyNonceToken(nonceToken);
  if (!nonceParsed) return Response.json({ error: 'bad_nonce' }, { status: 400 });

  let siwe: SiweMessage;
  try {
    siwe = new SiweMessage(body.message);
  } catch {
    return Response.json({ error: 'bad_message' }, { status: 400 });
  }

  if (siwe.nonce !== nonceParsed.nonce) {
    return Response.json({ error: 'nonce_mismatch' }, { status: 400 });
  }

  // Domain binding: reject a signed message prepared for a different origin.
  // Without this, a signature captured from a phishing site for the admin
  // wallet could be replayed here. Vercel forwards the public hostname via
  // x-forwarded-host; fall back to Host in local dev.
  const expectedDomain = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!expectedDomain) return Response.json({ error: 'no_host' }, { status: 400 });
  if (siwe.domain !== expectedDomain) {
    return Response.json({ error: 'domain_mismatch' }, { status: 400 });
  }

  // Chain binding: the admin MUST sign from Monad testnet. If their wallet is
  // on another chain when signing, reject — prevents a stray signature on
  // another chain from unlocking the dashboard.
  if (siwe.chainId !== monadTestnet.id) {
    return Response.json({ error: 'wrong_chain' }, { status: 400 });
  }

  try {
    const result = await siwe.verify({
      signature: body.signature,
      nonce: nonceParsed.nonce,
      domain: expectedDomain,
    });
    if (!result.success) return Response.json({ error: 'bad_signature' }, { status: 401 });
  } catch {
    return Response.json({ error: 'bad_signature' }, { status: 401 });
  }

  if (siwe.address.toLowerCase() !== ADMIN_ADDRESS.toLowerCase()) {
    return Response.json({ error: 'not_admin' }, { status: 403 });
  }

  store.set(SESSION_COOKIE, signSessionToken(siwe.address), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SEC,
  });
  store.set(NONCE_COOKIE, '', { path: '/', maxAge: 0 });

  return Response.json({ ok: true });
}
