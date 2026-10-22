// #214 Notification dedupe keys (NOTIFICATIONS_PLAN r8 §3.2). One row per user per thing: the UNIQUE
// (user_id, dedupe_key) makes re-runs, overlapping ticks, the seed script and stale-lock recovery no-ops. `c` is the
// lowercase contract address and ids are decimal strings, so the longest key (a 78-digit id) stays under the
// 200-byte CHECK.

export const poolResultKey = (contract: string, id: string) => `pool:${contract.toLowerCase()}:${id}:result`;
export const poolCreatorKey = (contract: string, id: string) => `pool:${contract.toLowerCase()}:${id}:creator`;
export const roundResultKey = (contract: string, id: string) => `round:${contract.toLowerCase()}:${id}:result`;
export const replyKey = (parentCommentId: string) => `reply:${parentCommentId}`;
