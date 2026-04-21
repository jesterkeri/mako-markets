// mako-abi.json is a copy of ../../scripts/mako-abi.json.
// KEEP IN SYNC: if the contract ABI changes, copy both files from
//   mako-contracts/out/MakoMarkets.sol/MakoMarkets.json
// (specifically the .abi field) into both scripts/mako-abi.json AND
// cf-worker/src/mako-abi.json.
import abiJson from './mako-abi.json';

export const makoAbi = abiJson.abi;
