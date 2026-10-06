// Node tests import the Worker entry, which re-exports the SchedulerState Durable Object. Outside workerd there is no
// `cloudflare:workers`; this stands in for its base class only so the module loads. The real object is tested in
// workerd (test/state.workers.test.ts); Node tests use test/lease-fake.ts.
export class DurableObject {
  constructor(..._args: unknown[]) {}
}
