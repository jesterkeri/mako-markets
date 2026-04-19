import 'server-only';

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { ADMIN_ADDRESS } from '@/lib/admin-address';

export const SESSION_COOKIE = 'mako_admin_session';
export const NONCE_COOKIE = 'mako_admin_nonce';

export const SESSION_MAX_AGE_SEC = 60 * 60 * 24;
export const NONCE_MAX_AGE_SEC = 60 * 5;

type SessionPayload = { address: string; exp: number };
type NoncePayload = { nonce: string; exp: number };

function getSecret(): Buffer {
  const s = process.env.ADMIN_SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'ADMIN_SESSION_SECRET missing or too short (need ≥32 chars). Generate with `openssl rand -hex 32` and set in .env.local and Vercel env.',
    );
  }
  return Buffer.from(s, 'utf8');
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payloadJson: string): string {
  const body = b64url(Buffer.from(payloadJson, 'utf8'));
  const mac = b64url(createHmac('sha256', getSecret()).update(body).digest());
  return `${body}.${mac}`;
}

function verify<T>(token: string): T | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = b64url(createHmac('sha256', getSecret()).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(body).toString('utf8')) as T & { exp: number };
    if (typeof parsed.exp !== 'number' || Date.now() / 1000 > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

export function signNonceToken(nonce: string): string {
  const payload: NoncePayload = { nonce, exp: Math.floor(Date.now() / 1000) + NONCE_MAX_AGE_SEC };
  return sign(JSON.stringify(payload));
}

export function verifyNonceToken(token: string): NoncePayload | null {
  return verify<NoncePayload>(token);
}

export function signSessionToken(address: string): string {
  const payload: SessionPayload = {
    address: address.toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC,
  };
  return sign(JSON.stringify(payload));
}

export function verifySessionToken(token: string): SessionPayload | null {
  return verify<SessionPayload>(token);
}

/**
 * Reads the session cookie from the current request, verifies the HMAC and
 * expiry, and confirms the address matches the current ADMIN_ADDRESS. Returns
 * the payload on success, null otherwise. Use this at the top of every
 * admin API route before doing any work.
 */
export async function getAdminSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const parsed = verifySessionToken(raw);
  if (!parsed) return null;
  if (parsed.address !== ADMIN_ADDRESS.toLowerCase()) return null;
  return parsed;
}
