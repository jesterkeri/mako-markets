// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC165} from "./interfaces/IERC165.sol";
import {IReceiver} from "./interfaces/IReceiver.sol";

/// @notice The one MakoRoundsV1 function this adapter calls. Permissionless on the deployed contract
/// (0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921, Monad testnet), selector 0x577b64a0.
interface IMakoRoundsSettle {
    function settle(uint256 roundId, bytes calldata anchorReport, bytes calldata closeReport) external;
}

/// @title MakoRoundsCreAdapter
/// @notice Lets a Chainlink CRE workflow settle MakoRoundsV1 rounds. CRE's EVM write delivers a DON-signed
/// report to a receiver's `onReport` through the KeystoneForwarder; the deployed MakoRoundsV1 has no
/// `onReport`, so this adapter receives the report and calls the contract's permissionless `settle`.
///
/// It is deliberately powerless:
///   - it holds no funds (no payable function, no receive or fallback) and keeps no state;
///   - it has no owner and nothing is configurable after deployment;
///   - it grants nothing: anyone can already call `settle` directly with the same arguments, and
///     MakoRoundsV1 verifies both Data Streams reports on-chain through Chainlink's VerifierProxy and
///     derives the outcome itself. Settlement correctness stays entirely with MakoRoundsV1.
/// The forwarder check below is there so the adapter only acts on DON-signed reports, as CRE expects of a
/// receiver; it protects no value, since `settle` is open to everyone anyway.
///
/// Workflow identity (SPEC §5.1: "FORWARDER, with matching workflow owner and id"). The adapter checks the
/// workflow OWNER from the report metadata when EXPECTED_AUTHOR is set. It does not check the workflow ID: the
/// ID is derived from the workflow's config, the config holds this adapter's address, and this adapter is
/// immutable, so an expected ID could only be set by an owner the adapter deliberately does not have.
/// EXPECTED_AUTHOR is zero ONLY for the simulation instance wired to the MockKeystoneForwarder, which per
/// Chainlink's docs ("Building consumer contracts") passes no workflow metadata, so any metadata check would
/// fail every simulation. The KeystoneForwarder instance must be deployed with the workflow owner's address.
///
/// Report layout (what the workflow signs): abi.encode(uint256 roundId, bytes anchorReport, bytes closeReport).
/// That is byte-for-byte the argument encoding of `settle`, so the call forwards it unchanged.
contract MakoRoundsCreAdapter is IReceiver {
    /// @notice The Chainlink KeystoneForwarder allowed to call `onReport`.
    address public immutable FORWARDER;
    /// @notice The MakoRoundsV1 contract whose `settle` this adapter calls.
    IMakoRoundsSettle public immutable ROUNDS;
    /// @notice The workflow owner whose reports are accepted; zero only for the simulation instance (see above).
    address public immutable EXPECTED_AUTHOR;

    /// @notice A report was decoded and `settle` returned without reverting.
    event SettleForwarded(uint256 indexed roundId);

    error ZeroAddress();
    error NotAContract(address account);
    error NotForwarder(address caller);
    error MetadataTooShort(uint256 length);
    error WrongWorkflowAuthor(address author);

    constructor(address forwarder, address rounds, address expectedAuthor) {
        if (forwarder == address(0) || rounds == address(0)) revert ZeroAddress();
        if (forwarder.code.length == 0) revert NotAContract(forwarder);
        if (rounds.code.length == 0) revert NotAContract(rounds);
        FORWARDER = forwarder;
        ROUNDS = IMakoRoundsSettle(rounds);
        EXPECTED_AUTHOR = expectedAuthor;
    }

    /// @inheritdoc IReceiver
    /// @dev Any revert from `settle` (RoundAlreadyTerminal, SpreadTooWide, WrongObservationTime, ...)
    /// propagates with its original revert data. The forwarder records the transmission as failed and the
    /// workflow sees ReceiverContractExecutionStatus REVERTED.
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != FORWARDER) revert NotForwarder(msg.sender);
        if (EXPECTED_AUTHOR != address(0)) {
            // Metadata layout (Chainlink ReceiverTemplate): bytes32 workflowId | bytes10 workflowName |
            // address workflowOwner | bytes2 reportId, so the owner is bytes [42, 62).
            if (metadata.length < 62) revert MetadataTooShort(metadata.length);
            address author = address(bytes20(metadata[42:62]));
            if (author != EXPECTED_AUTHOR) revert WrongWorkflowAuthor(author);
        }
        (uint256 roundId, bytes memory anchorReport, bytes memory closeReport) =
            abi.decode(report, (uint256, bytes, bytes));
        ROUNDS.settle(roundId, anchorReport, closeReport);
        emit SettleForwarded(roundId);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
