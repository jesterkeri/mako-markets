// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice ERC-165 standard interface detection (https://eips.ethereum.org/EIPS/eip-165), as used by
/// Chainlink's KeystoneForwarder to check that a receiver implements IReceiver before delivering a report.
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}
