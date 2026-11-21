// A request body is read only when it can be small: a declared `content-length` over the limit is refused BEFORE
// any byte is read, and a body with no (or a false) length is read in pieces and cut off at the limit.
import { MAX_BODY_BYTES } from './config';

export type Body = { ok: true; text: string } | { ok: false };

export async function readBody(req: Request, limit = MAX_BODY_BYTES): Promise<Body> {
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > limit)) return { ok: false };
  if (!req.body) return { ok: true, text: '' };
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    text += decoder.decode(value, { stream: true });
  }
  return { ok: true, text: text + decoder.decode() };
}
