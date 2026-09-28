// GENERATED from mako-contracts `forge inspect MakoRoundsV1 abi --json` at a728c74: the four functions the
// delivery path calls (pendingSettlement, DURATION, closeTimeOf, settle) and every custom error, so a
// simulated revert decodes to its name. Regenerate from that command after any contract change;
// keeper/test/delivery.test.ts checks the settle selector and error selectors against `cast sig`.
export const ROUNDS_ABI = [
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
    "name": "closeTimeOf",
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
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingSettlement",
    "inputs": [],
    "outputs": [
      {
        "name": "ids",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "settle",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "anchorReport",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "closeReport",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "error",
    "name": "AlreadyOnTheOtherSide",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BelowMinimumEntry",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BidAskOutOfOrder",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CreatorHasActiveRound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CreatorsNotStrictlyAscending",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EntriesClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "FeeManagerEnabled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InexactTransfer",
    "inputs": [
      {
        "name": "expected",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "received",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidSide",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LeadTooLong",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LeadTooShort",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoCreators",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoSuchRound",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NonPositivePrice",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotACreator",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotRefundableYet",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotTreasury",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NothingOwed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ObservationInFuture",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Reentrancy",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReportExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RoundAlreadyTerminal",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RoundIsOneSided",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RoundNotTerminal",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SpreadTooWide",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StartTimeNotOnBoundary",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StartTimeOutOfRange",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SubmitWindowClosed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooEarlyToSettle",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TooManyActiveRounds",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TransferFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ValidFromAfterObservation",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongFeed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongObservationTime",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongSchema",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  }
] as const;
