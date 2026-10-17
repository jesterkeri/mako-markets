// ----------------------------------------------------------------------------
// price-recorder/src/index.ts
//
// The recorder Worker (CHARTS_DS_PLAN section 2). Unit (a) of the build ships the decoding and candle rules only, so
// the Worker has no cron and records nothing yet; its HTTP surface answers 503 until the read API (unit e) exists,
// which is also what a request without a token will get later (plan section 11).
// ----------------------------------------------------------------------------

export default {
  async fetch(): Promise<Response> {
    return Response.json({ error: 'not_serving' }, { status: 503 });
  },
} satisfies ExportedHandler;
