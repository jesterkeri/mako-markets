// GENERATED. Do not edit by hand.
//
// The MakoRoundsV1 ABI, from `forge inspect src/MakoRoundsV1.sol:MakoRoundsV1 abi --json` in mako-contracts.
// Source: src/MakoRoundsV1.sol, identical at d946901 (Codex T1.1 SHIP), 9c95e10 and a728c74 (the deploy script);
// sha256 of that source d9d2082b7c5e237b9aade49a8f2e5ed220ec41a8fd92dd7805b8841dac58c1e8. Regenerate from the deployed commit if the contract ever changes.

export const roundsAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "treasury",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "usdc",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "creators",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "BOUNDARY_STEP",
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
    "name": "CREATORS_HASH",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "CREATOR_FEE_BPS",
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
    "name": "MAX_ACTIVE_ROUNDS",
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
    "name": "MAX_LEAD",
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
    "name": "MIN_ENTRY",
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
    "name": "MIN_LEAD",
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
    "name": "PROTOCOL_FEE_BPS",
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
    "name": "TREASURY",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "USDC",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract IERC20"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "activeRoundCount",
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
    "name": "claim",
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
    "name": "creatorActiveRound",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
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
    "name": "creatorFeeClaimed",
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
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "enter",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "side",
        "type": "uint8",
        "internalType": "enum MakoRoundsV1.Side"
      },
      {
        "name": "amount",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "entryCloseTimeOf",
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
    "name": "isCreator",
    "inputs": [
      {
        "name": "who",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
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
    "name": "phaseOf",
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
        "type": "uint8",
        "internalType": "enum MakoRoundsV1.Phase"
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
  },
  {
    "type": "function",
    "name": "schedule",
    "inputs": [
      {
        "name": "startTime",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "nonpayable"
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
    "type": "function",
    "name": "stakeClaimed",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "who",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "stakeOf",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "who",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct MakoRoundsV1.Stake",
        "components": [
          {
            "name": "side",
            "type": "uint8",
            "internalType": "enum MakoRoundsV1.Side"
          },
          {
            "name": "amount",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "submitDeadlineOf",
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
    "name": "treasuryBalance",
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
    "name": "withdrawTreasury",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "Claimed",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "who",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "stakePart",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "creatorFeePart",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Entered",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "entrant",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "side",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum MakoRoundsV1.Side"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "stakeTotal",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FeesAccrued",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "total",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "protocolFee",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "creatorFee",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "distributable",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RemainderSwept",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoundRefunded",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "reason",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum MakoRoundsV1.RefundReason"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoundScheduled",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "creator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "openTime",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "startTime",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "entryCloseTime",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "closeTime",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "submitDeadline",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoundSettled",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "outcome",
        "type": "uint8",
        "indexed": false,
        "internalType": "enum MakoRoundsV1.Outcome"
      },
      {
        "name": "anchorPrice",
        "type": "int192",
        "indexed": false,
        "internalType": "int192"
      },
      {
        "name": "closePrice",
        "type": "int192",
        "indexed": false,
        "internalType": "int192"
      },
      {
        "name": "anchorObservedAt",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "closeObservedAt",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "anchorReportHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "closeReportHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "settler",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "RoundTied",
    "inputs": [
      {
        "name": "roundId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "anchorPrice",
        "type": "int192",
        "indexed": false,
        "internalType": "int192"
      },
      {
        "name": "closePrice",
        "type": "int192",
        "indexed": false,
        "internalType": "int192"
      },
      {
        "name": "anchorObservedAt",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "closeObservedAt",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "anchorReportHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "closeReportHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "settler",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TreasuryWithdrawn",
    "inputs": [
      {
        "name": "to",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
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
