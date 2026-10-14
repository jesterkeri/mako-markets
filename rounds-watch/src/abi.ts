// GENERATED from mako-contracts `forge inspect MakoRoundsV1 abi --json` at a728c74: the three read-only
// functions the liveness watch calls. Regenerate from that command after any contract change.
export const WATCH_ABI = [
  {
    "type": "function",
    "name": "DURATION",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "roundCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "roundOf",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct MakoRoundsV1.Round",
        "components": [
          {
            "name": "creator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "openTime",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "startTime",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "status",
            "type": "uint8",
            "internalType": "enum MakoRoundsV1.Status"
          },
          {
            "name": "outcome",
            "type": "uint8",
            "internalType": "enum MakoRoundsV1.Outcome"
          },
          {
            "name": "refundReason",
            "type": "uint8",
            "internalType": "enum MakoRoundsV1.RefundReason"
          },
          {
            "name": "anchorPrice",
            "type": "int192",
            "internalType": "int192"
          },
          {
            "name": "closePrice",
            "type": "int192",
            "internalType": "int192"
          },
          {
            "name": "anchorObservedAt",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "closeObservedAt",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "anchorReportHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "closeReportHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "upPool",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "downPool",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "upEntrants",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "downEntrants",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "protocolFee",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "creatorFee",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "distributable",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "winnersClaimed",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "paidOut",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  }
] as const;

/// MakoRoundsV1 enums, in declaration order (src/MakoRoundsV1.sol).
export const STATUS = { None: 0, Active: 1, Settled: 2, Refunded: 3 } as const;
export const REFUND_REASON = { None: 0, OneSided: 1, Tie: 2, NoPrice: 3 } as const;
