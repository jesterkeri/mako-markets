// Adversary on 9bc8a37: runs test/adv-ccip2-workerd.workers.test.ts inside workerd with every outbound fetch answered
// offline by miniflare's outboundService (no network). rpc.test answers every request with a 307 to gateway.test;
// gateway.test counts what reaches it; count.test reports the counts. Run: npx vitest run -c test/adv-ccip2-workers.config.ts
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

let gatewayHits = 0;
let rpcHits = 0;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: { ADV_CCIP2: '1' },
        outboundService: async (request: Request) => {
          const url = new URL(request.url);
          if (url.hostname === 'rpc.test') {
            rpcHits += 1;
            return new Response(null, { status: 307, headers: { location: 'http://gateway.test/' } });
          }
          if (url.hostname === 'gateway.test') {
            gatewayHits += 1;
            return Response.json({ jsonrpc: '2.0', id: 1, result: '0x' });
          }
          if (url.hostname === 'count.test') {
            const out = Response.json({ gatewayHits, rpcHits });
            if (url.pathname === '/reset') gatewayHits = rpcHits = 0;
            return out;
          }
          return new Response('blocked: offline test', { status: 599 });
        },
      },
    }),
  ],
  test: { include: ['test/adv-ccip2-*.workers.test.ts'], testTimeout: 30_000 },
});
