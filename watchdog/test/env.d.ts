// Types the `env` from cloudflare:workers in tests with the Worker's bindings.
import type { Env as WatchdogEnv } from '../src/index';

declare global {
  namespace Cloudflare {
    interface Env extends WatchdogEnv {}
  }
}

export {};
