// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The handful of Foundry cheatcodes these tests use, declared directly so the project needs no
/// forge-std submodule. Signatures as in Foundry's cheatcode spec (https://book.getfoundry.sh/cheatcodes/).
interface Vm {
    function prank(address msgSender) external;
    function expectRevert() external;
    function expectRevert(bytes calldata revertData) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData) external;
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory);
    function createSelectFork(string calldata urlOrAlias) external returns (uint256);
    function deal(address account, uint256 newBalance) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 a, uint256 b, string memory what) internal pure {
        require(a == b, what);
    }

    function assertEq(bytes memory a, bytes memory b, string memory what) internal pure {
        require(keccak256(a) == keccak256(b), what);
    }

    function assertTrue(bool v, string memory what) internal pure {
        require(v, what);
    }
}
