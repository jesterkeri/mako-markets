// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestBase} from "./Vm.sol";
import {MakoRoundsCreAdapter} from "../src/MakoRoundsCreAdapter.sol";
import {IReceiver} from "../src/interfaces/IReceiver.sol";
import {IERC165} from "../src/interfaces/IERC165.sol";

/// @dev Stands in for MakoRoundsV1: records the last settle call, or reverts with MakoRoundsV1's own
/// custom errors (same names, so the same selectors) when told to.
contract RoundsStub {
    error RoundAlreadyTerminal();
    error SpreadTooWide();

    uint256 public calls;
    uint256 public lastRoundId;
    bytes public lastAnchor;
    bytes public lastClose;
    address public lastSender;
    bytes4 public revertWith;

    function setRevert(bytes4 sel) external {
        revertWith = sel;
    }

    function settle(uint256 roundId, bytes calldata anchorReport, bytes calldata closeReport) external {
        if (revertWith == RoundAlreadyTerminal.selector) revert RoundAlreadyTerminal();
        if (revertWith == SpreadTooWide.selector) revert SpreadTooWide();
        calls++;
        lastRoundId = roundId;
        lastAnchor = anchorReport;
        lastClose = closeReport;
        lastSender = msg.sender;
    }
}

/// @dev Any contract will do as the forwarder in unit tests; the adapter only compares msg.sender.
contract ForwarderStub {}

contract MakoRoundsCreAdapterTest is TestBase {
    event SettleForwarded(uint256 indexed roundId);

    RoundsStub internal rounds;
    address internal forwarder;
    MakoRoundsCreAdapter internal adapter;

    /// abi.encode(uint256 42, bytes 0x0102, bytes 0xabcdef), produced by the WORKFLOW's own encoder
    /// (viem, cre/rounds-settle/settle-rounds/logic.ts encodeSettleReport), pasted verbatim. Decoding it here
    /// proves the TypeScript side and the Solidity side agree on the report layout.
    bytes internal constant VIEM_VECTOR =
        hex"000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000000201020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003abcdef0000000000000000000000000000000000000000000000000000000000";

    function setUp() public {
        rounds = new RoundsStub();
        forwarder = address(new ForwarderStub());
        adapter = new MakoRoundsCreAdapter(forwarder, address(rounds));
    }

    // ---------------------------------------------------------------- constructor

    function test_constructor_storesImmutables() public view {
        assertTrue(adapter.FORWARDER() == forwarder, "forwarder");
        assertTrue(address(adapter.ROUNDS()) == address(rounds), "rounds");
    }

    function test_constructor_refusesZeroAddresses() public {
        vm.expectRevert(abi.encodeWithSelector(MakoRoundsCreAdapter.ZeroAddress.selector));
        new MakoRoundsCreAdapter(address(0), address(rounds));
        vm.expectRevert(abi.encodeWithSelector(MakoRoundsCreAdapter.ZeroAddress.selector));
        new MakoRoundsCreAdapter(forwarder, address(0));
    }

    function test_constructor_refusesAccountsWithoutCode() public {
        address eoa = address(0xBEEF);
        vm.expectRevert(abi.encodeWithSelector(MakoRoundsCreAdapter.NotAContract.selector, eoa));
        new MakoRoundsCreAdapter(eoa, address(rounds));
        vm.expectRevert(abi.encodeWithSelector(MakoRoundsCreAdapter.NotAContract.selector, eoa));
        new MakoRoundsCreAdapter(forwarder, eoa);
    }

    // ---------------------------------------------------------------- forwarder-only

    function testFuzz_onReport_refusesAnyoneButTheForwarder(address caller) public {
        if (caller == forwarder) return;
        bytes memory report = abi.encode(uint256(1), hex"01", hex"02");
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(MakoRoundsCreAdapter.NotForwarder.selector, caller));
        adapter.onReport("", report);
        assertEq(rounds.calls(), 0, "settle must not be reached");
    }

    // ---------------------------------------------------------------- decoding and forwarding

    function test_onReport_decodesAndCallsSettleWithExactArguments() public {
        bytes memory anchorReport = hex"00090d9e8d96765a0c49e03a6ae05c82e8f8de70cf179baa632f18313e54bd69";
        bytes memory closeReport = hex"0102030405060708090a0b0c0d0e0f";
        vm.expectEmit(true, false, false, true);
        emit SettleForwarded(77);
        vm.prank(forwarder);
        adapter.onReport(hex"1234", abi.encode(uint256(77), anchorReport, closeReport));
        assertEq(rounds.calls(), 1, "one settle call");
        assertEq(rounds.lastRoundId(), 77, "roundId");
        assertEq(rounds.lastAnchor(), anchorReport, "anchor bytes");
        assertEq(rounds.lastClose(), closeReport, "close bytes");
        assertTrue(rounds.lastSender() == address(adapter), "settle is called by the adapter");
    }

    function test_onReport_acceptsTheWorkflowEncoding() public {
        vm.prank(forwarder);
        adapter.onReport("", VIEM_VECTOR);
        assertEq(rounds.lastRoundId(), 42, "roundId from the viem vector");
        assertEq(rounds.lastAnchor(), hex"0102", "anchor from the viem vector");
        assertEq(rounds.lastClose(), hex"abcdef", "close from the viem vector");
    }

    function testFuzz_onReport_forwardsAnyReportBytesUnchanged(uint256 roundId, bytes calldata a, bytes calldata c) public {
        vm.prank(forwarder);
        adapter.onReport("", abi.encode(roundId, a, c));
        assertEq(rounds.lastRoundId(), roundId, "roundId");
        assertEq(rounds.lastAnchor(), a, "anchor");
        assertEq(rounds.lastClose(), c, "close");
    }

    function test_onReport_metadataIsIgnored() public {
        bytes memory report = abi.encode(uint256(5), hex"aa", hex"bb");
        vm.prank(forwarder);
        adapter.onReport(new bytes(64), report);
        vm.prank(forwarder);
        adapter.onReport("", report);
        assertEq(rounds.calls(), 2, "both delivered");
    }

    function test_onReport_malformedReportReverts() public {
        vm.prank(forwarder);
        vm.expectRevert();
        adapter.onReport("", hex"0102");
        vm.prank(forwarder);
        vm.expectRevert();
        adapter.onReport("", abi.encode(uint256(1))); // missing both byte arrays
        assertEq(rounds.calls(), 0, "settle must not be reached");
    }

    // ---------------------------------------------------------------- revert propagation

    function test_onReport_propagatesSettleRevertData() public {
        rounds.setRevert(RoundsStub.RoundAlreadyTerminal.selector);
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(RoundsStub.RoundAlreadyTerminal.selector));
        adapter.onReport("", abi.encode(uint256(3), hex"aa", hex"bb"));

        rounds.setRevert(RoundsStub.SpreadTooWide.selector);
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(RoundsStub.SpreadTooWide.selector));
        adapter.onReport("", abi.encode(uint256(3), hex"aa", hex"bb"));
    }

    // ---------------------------------------------------------------- ERC-165 and no funds

    function test_supportsInterface() public view {
        assertTrue(type(IReceiver).interfaceId == bytes4(0x805f2132), "IReceiver id is the onReport selector");
        assertTrue(adapter.supportsInterface(type(IReceiver).interfaceId), "IReceiver");
        assertTrue(adapter.supportsInterface(type(IERC165).interfaceId), "IERC165");
        assertTrue(!adapter.supportsInterface(0xffffffff), "0xffffffff must be false per ERC-165");
        assertTrue(!adapter.supportsInterface(0x577b64a0), "unrelated id");
    }

    function test_cannotReceiveNativeValue() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(adapter).call{value: 1}("");
        assertTrue(!ok, "plain transfer must fail");
        (ok,) = address(adapter).call{value: 1}(abi.encodeCall(adapter.onReport, ("", abi.encode(uint256(1), hex"", hex""))));
        assertTrue(!ok, "onReport is not payable");
        assertEq(address(adapter).balance, 0, "adapter holds nothing");
    }
}

/// @dev Against the REAL deployed contracts on a Monad testnet fork. Runs only when MONAD_RPC_URL is set:
///   MONAD_RPC_URL=https://testnet-rpc.monad.xyz forge test --network monad --match-contract Fork -vv
/// (`--network monad`: Foundry 1.8 refuses to fork a Monad chain from its default Ethereum EVM.)
contract MakoRoundsCreAdapterForkTest is TestBase {
    address internal constant ROUNDS = 0x9dC0e0b9E8F1905740D8B98E90fe07288dcC2921;
    /// KeystoneForwarder for "monad-testnet" (CRE forwarder directory; typeAndVersion "KeystoneForwarder 1.0.0").
    address internal constant FORWARDER = 0xF8344CFd5c43616a4366C34E3EEE75af79a74482;
    /// MakoRoundsV1.NoSuchRound()
    bytes4 internal constant NO_SUCH_ROUND = 0x5d057c1d;

    function test_fork_deployedRoundsRevertReachesTheForwarder() public {
        string memory rpc = vm.envOr("MONAD_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return; // not configured: nothing to check
        vm.createSelectFork(rpc);
        MakoRoundsCreAdapter adapter = new MakoRoundsCreAdapter(FORWARDER, ROUNDS);
        // A round id that cannot exist: the deployed MakoRoundsV1 decodes the forwarded call (proving the
        // selector and argument layout match its bytecode) and reverts NoSuchRound, which surfaces unchanged.
        vm.prank(FORWARDER);
        vm.expectRevert(abi.encodeWithSelector(NO_SUCH_ROUND));
        adapter.onReport("", abi.encode(type(uint256).max, hex"00", hex"00"));
    }
}
