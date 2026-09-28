// Types the `env` from cloudflare:workers in tests with the Worker's bindings.
import type { Env as WatchEnv } from '../src/index';

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging needs an empty extension
    interface Env extends WatchEnv {}
  }
}

export {};
