// The reviewed MakoRoundsV1 deployment record (Codex S2 r1). Rounds is live only for the deployment written here: its
// address, the keccak256 of its runtime code and the USDC it was built with. Changing this file is a reviewed change,
// never an environment edit. Null until MakoRoundsV1 is deployed and its record is reviewed.

export type RoundsRelease = { address: `0x${string}`; runtimeCodeHash: `0x${string}`; usdc: `0x${string}` };

export const ROUNDS_RELEASE_RECORD: RoundsRelease | null = null;
