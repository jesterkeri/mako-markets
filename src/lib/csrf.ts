import 'server-only';

// ----------------------------------------------------------------------------
// src/lib/csrf.ts
//
// Same-origin gate for state-changing routes that set or revoke session
// cookies. Without this, /api/user/auth is vulnerable to login CSRF: an
// attacker can make a victim's browser POST the attacker's valid Magic DID
// token, and the response sets the victim's `mako_user_session` cookie to
// the attacker's account. Subsequent deposits / profile actions on the
// victim's browser would route to the attacker's Safe.
//
// The check requires all three:
//   1. An `Origin` header is present.
//   2. Origin's scheme matches the request's effective scheme (taken from
//      `x-forwarded-proto` behind a proxy, falling back to the URL's protocol).
//   3. Origin's host matches the request's `Host` (or `x-forwarded-host`
//      when behind Vercel's edge), including port.
//
// Comparing scheme matters because a request hitting the app via http but
// presenting an https Origin (or vice versa) is a misconfiguration / mixed-
// content trap that we'd rather refuse than guess at.
//
// Modern browsers send `Origin` on every cross-origin and same-origin POST
// from a fetch. A request without an `Origin` header is either non-browser
// or a deeply legacy client; treating it as cross-origin is conservative
// and correct here.
//
// Sec-Fetch-Site is a stronger signal but isn't universally available, so
// we anchor on `Origin`. If you need to extend later, the cleanest place is
// to add a Sec-Fetch-Site allowlist as an additional clause.
// ----------------------------------------------------------------------------

export type SameOriginCheck =
  | { ok: true }
  | {
      ok: false;
      reason: 'no_origin' | 'no_host' | 'no_proto' | 'mismatch';
    };

export function checkSameOrigin(req: Request): SameOriginCheck {
  const originHeader = req.headers.get('origin');
  if (!originHeader) {
    return { ok: false, reason: 'no_origin' };
  }

  const expectedHost =
    req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!expectedHost) {
    return { ok: false, reason: 'no_host' };
  }

  // Scheme: prefer the proxy-reported value; fall back to the URL Next built
  // for this request. Strip the trailing colon so we compare bare strings
  // ('https' vs 'https'), not 'https:' vs 'https'.
  let expectedProto = req.headers.get('x-forwarded-proto');
  if (!expectedProto) {
    try {
      expectedProto = new URL(req.url).protocol.replace(/:$/, '');
    } catch {
      return { ok: false, reason: 'no_proto' };
    }
  }
  if (!expectedProto) {
    return { ok: false, reason: 'no_proto' };
  }

  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return { ok: false, reason: 'mismatch' };
  }

  const originProto = originUrl.protocol.replace(/:$/, '');
  if (originProto !== expectedProto) {
    return { ok: false, reason: 'mismatch' };
  }

  if (originUrl.host !== expectedHost) {
    return { ok: false, reason: 'mismatch' };
  }

  return { ok: true };
}
