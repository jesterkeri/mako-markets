// The reviewed MakoRoundsV1 deployment record (Codex S2 r1). Rounds is live only for the deployment written here: its
// address, the keccak256 of its runtime code and the USDC it was built with. Changing this file is a reviewed change,
// never an environment edit. Null until MakoRoundsV1 is deployed and its record is reviewed.

export type RoundsRelease = { address: `0x${string}`; runtimeCodeHash: `0x${string}`; usdc: `0x${string}` };

/// MakoRoundsV1 on Monad testnet, deployed 2026-10-06 by the keeper wallet from mako-contracts c79c9d0 (Codex T1.5
/// SHIP): transaction 0x09b90af8af907e8106b0c8cc2de80f8c583614979430efc8111c9649a9f36ff8, block 68759154. Its receipt,
/// written by verifyDeployment against the chain, is mako-contracts
/// deployments/rounds-v1-10143-0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921.json (commit 1d787f6); CI checks this record
/// against that receipt (rounds-surface.test.ts). Treasury 0xC8BF886f73E4371CBd8160EEA7683b8Da98190F1; creators
/// 0xE3600a066318C30f298074Ec2f24C9fCdce409E7, 0xe490aB83c7f247BEC7d5E04Ce04bc48D6609b550,
/// 0xf301DdF76efb3F342e8c6b3b9Eb52B6D9851d801; MAX_ACTIVE_ROUNDS 10.
export const ROUNDS_RELEASE_RECORD: RoundsRelease | null = {
  address: '0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921',
  runtimeCodeHash: '0x2b39edd6d2bf8218c4a09c7a1bac643a1693879cd2bd61076d51d69f412770f9',
  usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
};
