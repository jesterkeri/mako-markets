// Types the `env` from cloudflare:workers in workerd tests with the Worker's Durable Object binding.
import type { SchedulerState } from '../src/state';

declare global {
  namespace Cloudflare {
    interface Env {
      SCHEDULER_STATE: DurableObjectNamespace<SchedulerState>;
    }
  }
}

export {};
