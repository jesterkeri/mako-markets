// GENERATED ABIs for the keeper's refund duties (Joshua 2026-09-29: after 24 hours, refund automatically).
//   ROUNDS_REFUND_ABI  from mako-contracts `forge inspect MakoRoundsV1 abi --json` at a728c74
//   POOLS_ABI          from `forge inspect MakoMarketsV4 abi --json`; the struct, forceRefund, getMarket,
//                      nextMarketId and RESOLUTION_GRACE are identical in d088ced, the live V4's source
//                      (checked 2026-09-29), and live V4 answers getMarket with this layout.
export const ROUNDS_REFUND_ABI = [
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
    "name": "ENTRY_LEAD",
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
    "name": "SUBMIT_WINDOW",
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
    "name": "finalizeRefund",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
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

export const POOLS_ABI = [
  {
    "type": "function",
    "name": "RESOLUTION_GRACE",
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
    "name": "forceRefund",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "getMarket",
    "inputs": [
      {
        "name": "id",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct MakoMarketsV4.Market",
        "components": [
          {
            "name": "creator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "mType",
            "type": "uint8",
            "internalType": "enum MakoMarketsV4.MarketType"
          },
          {
            "name": "oracleRef",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "question",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "createdAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "closeTime",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "bettingCloseTime",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "totalYes",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "totalNo",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "yesBettorCount",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "noBettorCount",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "outcome",
            "type": "uint8",
            "internalType": "enum MakoMarketsV4.Outcome"
          },
          {
            "name": "resolved",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "creatorFeeClaimed",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "protocolFeeBpsSnapshot",
            "type": "uint16",
            "internalType": "uint16"
          },
          {
            "name": "creatorFeeBpsSnapshot",
            "type": "uint16",
            "internalType": "uint16"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "nextMarketId",
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
    "type": "error",
    "name": "AlreadyClaimed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "AlreadyResolved",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadCloseTime",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadDecimals",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadDuration",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadOutcome",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BadQuestion",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BelowMin",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BetTooSoon",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BettingClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CreatorDailyCapExceeded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CreatorSeedNotAllowed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CreatorSeedTooSmall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ERC20TransferFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ERC20TransferFromFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FeesTooHigh",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MarketClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MarketMissing",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MarketNotClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoPosition",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAuthorized",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOwnerForMakoMarket",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotResolved",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotResolver",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Reentrancy",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StillInGrace",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TransferAmountMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WalletCapExceeded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WalletIsBlocked",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WalletShareCapExceeded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;

/// MakoRoundsV1.Status, in declaration order.
export const ROUND_STATUS = { None: 0, Active: 1, Settled: 2, Refunded: 3 } as const;
