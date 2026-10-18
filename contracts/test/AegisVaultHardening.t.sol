// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {AegisVault} from "../src/AegisVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockSwap} from "../src/mocks/MockSwap.sol";

/**
 * @dev CP1.1 hardening patch — dedicated tests for:
 *
 *        1. Rolling 24h ring-buffer window (fail-closed when full)
 *        2. MockSwap venue: fixed rate, minOut floor, unified accounting
 *        3. logRejection: the on-chain rejection ledger
 *        4. rationaleHash: indexed keccak256(reason) on agent events
 *
 *      PRD references: 9.2 (MockSwap), 9.3 (rolling window, INV-1..4),
 *      9.4 (rejection ledger + rationale hash).
 */
contract AegisVaultHardeningTest is BaseTest {
    string constant R = "CP1.1 hardening";

    // ================================================================
    // 1. Rolling window — fail-closed integrity (INV-3)
    // ================================================================

    /// @dev Fill all 64 ring slots with live entries; the 65th spend must
    ///      FAIL CLOSED with Aegis__DailyWindowUncertain (never under-count).
    function test_window_fails_closed_when_buffer_full() public {
        usdc.mint(address(vault), 200_000e6); // room for the balance check
        vm.prank(owner);
        vault.setTokenPolicy(address(usdc), 1000e6, 100_000e6);

        for (uint256 i = 0; i < vault.WINDOW_CAPACITY(); i++) {
            vm.prank(agent);
            vault.agentExecute(address(usdc), savings, 1000e6, "fill the ring");
        }

        (uint256 live, uint256 capacity) = vault.windowState(address(usdc));
        assertEq(live, 64, "all ring slots live");
        assertEq(capacity, 64, "capacity is 64");
        assertEq(vault.spentInWindow(address(usdc)), 64_000e6);

        // the 65th spend fits the caps but the window state is UNCERTAIN -> refuse
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__DailyWindowUncertain.selector, address(usdc)));
        vault.agentExecute(address(usdc), savings, 1000e6, "one spend too many");

        // the swap path shares the same fail-closed window
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__DailyWindowUncertain.selector, address(usdc)));
        vault.agentSwap(address(usdc), address(0), 1000e6, 0, "swap into a full window");
    }

    /// @dev Failing closed is temporary: once entries expire, spending resumes.
    function test_window_recovers_after_entries_expire() public {
        usdc.mint(address(vault), 200_000e6);
        vm.prank(owner);
        vault.setTokenPolicy(address(usdc), 1000e6, 100_000e6);

        for (uint256 i = 0; i < vault.WINDOW_CAPACITY(); i++) {
            vm.prank(agent);
            vault.agentExecute(address(usdc), savings, 1000e6, "fill the ring");
        }

        vm.warp(block.timestamp + 24 hours + 1 seconds); // everything expires

        (uint256 live,) = vault.windowState(address(usdc));
        assertEq(live, 0, "all entries expired");

        vm.prank(agent);
        vault.agentExecute(address(usdc), savings, 1000e6, "pruned and working again");
        assertEq(vault.spentInWindow(address(usdc)), 1000e6, "window healthy again");
    }

    function test_window_initially_empty() public view {
        (uint256 live, uint256 capacity) = vault.windowState(address(usdc));
        assertEq(live, 0);
        assertEq(capacity, 64);
        assertEq(vault.spentInWindow(address(usdc)), 0);
    }

    /// @dev Amounts above uint128 cannot be metered by the ring buffer —
    ///      refuse them explicitly rather than risk truncation.
    function test_oversized_amount_fails_closed() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__AmountTooLargeToMeter.selector, type(uint256).max));
        vault.agentExecute(address(usdc), savings, type(uint256).max, "absurd amount");
    }

    // ================================================================
    // 2. MockSwap — venue, minOut, unified accounting
    // ================================================================

    function test_agentSwap_usdc_to_eth_pays_out_and_consumes_window() public {
        uint256 vaultEthBefore = address(vault).balance;
        uint256 expected = _ethOut(200e6); // 0.05 ether at $4,000 / ETH

        string memory r = "Story 3: rebalance - sell 200 USDC for ETH at $4,000";
        vm.expectEmit();
        emit AegisVault.AgentSwapped(
            vault.seq() + 1, address(usdc), address(0), 200e6, expected, expected, 200e6, r, keccak256(bytes(r))
        );
        vm.prank(agent);
        vault.agentSwap(address(usdc), address(0), 200e6, expected, r);

        assertEq(usdc.balanceOf(address(venue)), 200e6, "venue received the USDC");
        assertEq(address(vault).balance, vaultEthBefore + expected, "vault received the ETH");
        assertEq(vault.spentInWindow(address(usdc)), 200e6, "unified accounting: swap consumed the window");
    }

    function test_agentSwap_eth_to_usdc() public {
        usdc.mint(address(venue), 10_000e6); // venue inventory
        vm.prank(owner);
        venue.setRate(address(0), address(usdc), 4_000e6, 1 ether); // 1 ETH -> 4,000 USDC

        vm.prank(agent);
        vault.agentSwap(address(0), address(usdc), 0.1 ether, 400e6, "sell ETH for USDC");

        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS + 400e6, "vault got the USDC");
        assertEq(vault.spentInWindow(address(0)), 0.1 ether, "ETH window consumed");
        assertEq(vault.spentInWindow(address(usdc)), 0, "buy side is NOT metered");
    }

    /// @dev Swaps and transfers draw from the SAME sell-side window —
    ///      there is no swap-shaped bypass of the spend caps.
    function test_swap_and_transfer_share_the_same_window() public {
        _execute(savings, 1000e6, R); // full per-tx transfer

        // 500 more fits the 1,500 window: swap it
        vm.prank(agent);
        vault.agentSwap(address(usdc), address(0), 500e6, _ethOut(500e6), "rebalance");
        assertEq(vault.spentInWindow(address(usdc)), 1500e6);

        // any further USDC outflow — transfer OR swap — is blocked
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__ExceedsDailyLimit.selector, address(usdc), DAILY, 1e6, DAILY)
        );
        vault.agentExecute(address(usdc), savings, 1e6, "nope");
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__ExceedsDailyLimit.selector, address(usdc), DAILY, 1e6, DAILY)
        );
        vault.agentSwap(address(usdc), address(0), 1e6, 0, "nope");
    }

    function test_agentSwap_per_tx_cap_applies_to_sell_side() public {
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__ExceedsPerTxLimit.selector, address(usdc), 1200e6, CAP_PER_TX)
        );
        vault.agentSwap(address(usdc), address(0), 1200e6, 0, "oversized swap");
    }

    /// @dev Slippage guard: output below minOut reverts (the venue enforces
    ///      it and the vault re-checks); the window entry, the approval and
    ///      the transfer all roll back atomically.
    function test_agentSwap_below_minOut_reverts_and_rolls_back() public {
        uint256 expected = _ethOut(200e6);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(MockSwap.MockSwap__BelowMinOut.selector, expected, expected + 1));
        vault.agentSwap(address(usdc), address(0), 200e6, expected + 1, "slippage too tight");

        assertEq(vault.spentInWindow(address(usdc)), 0, "window rolled back");
        assertEq(usdc.balanceOf(address(venue)), 0, "venue received nothing");
        assertEq(usdc.allowance(address(vault), address(venue)), 0, "no lingering approval");
    }

    function test_agentSwap_access_control_and_validation() public {
        // stranger cannot swap
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__NotAgent.selector, stranger));
        vault.agentSwap(address(usdc), address(0), 100e6, 0, "not the agent");

        // paused agent cannot swap
        vm.prank(owner);
        vault.pauseAgent();
        vm.prank(agent);
        vm.expectRevert(AegisVault.Aegis__AgentPaused.selector);
        vault.agentSwap(address(usdc), address(0), 100e6, 0, "while paused");

        // same-token pair is invalid
        vm.prank(owner);
        vault.resumeAgent();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__InvalidSwap.selector, address(usdc), address(usdc)));
        vault.agentSwap(address(usdc), address(usdc), 100e6, 0, "usdc for usdc");

        // zero amount is invalid
        vm.prank(agent);
        vm.expectRevert(AegisVault.Aegis__InvalidAmount.selector);
        vault.agentSwap(address(usdc), address(0), 0, 0, "zero sell");
    }

    function test_agentSwap_reverts_without_venue() public {
        vm.prank(owner);
        vault.setSwapVenue(address(0)); // owner disables swaps
        vm.prank(agent);
        vm.expectRevert(AegisVault.Aegis__SwapVenueNotSet.selector);
        vault.agentSwap(address(usdc), address(0), 100e6, 0, "no venue configured");
    }

    function test_setSwapVenue_owner_only_and_emits() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__NotOwner.selector, stranger));
        vault.setSwapVenue(stranger);

        vm.expectEmit();
        emit AegisVault.SwapVenueUpdated(address(venue), address(0xdead));
        vm.prank(owner);
        vault.setSwapVenue(address(0xdead));
        assertEq(vault.swapVenue(), address(0xdead));
    }

    /// @dev Unset rate pairs fail closed at the venue.
    function test_agentSwap_unset_rate_pair_reverts() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(MockSwap.MockSwap__RateNotSet.selector, address(0), address(usdc)));
        vault.agentSwap(address(0), address(usdc), 0.1 ether, 0, "rate never set");
    }

    // ================================================================
    // 3. logRejection — the on-chain rejection ledger
    // ================================================================

    function test_logRejection_agent_records_policy_refusal() public {
        bytes32 rh = keccak256("sweep 2,000 USDC refused: exceeds rolling window cap");
        vm.expectEmit();
        emit AegisVault.RejectionLogged(
            vault.seq() + 1, agent, rh, uint8(AegisVault.RejectionCategory.CapWindow), uint64(block.timestamp)
        );
        vm.prank(agent);
        vault.logRejection(rh, uint8(AegisVault.RejectionCategory.CapWindow));

        assertEq(vault.rejectionCount(), 1);
        AegisVault.Rejection memory rej = vault.getRejection(0);
        assertEq(rej.actor, agent);
        assertEq(rej.reasonHash, rh);
        assertEq(rej.category, uint8(AegisVault.RejectionCategory.CapWindow));
    }

    function test_logRejection_owner_can_log() public {
        vm.prank(owner);
        vault.logRejection(
            keccak256("risk engine: look-alike recipient"), uint8(AegisVault.RejectionCategory.RiskEngine)
        );
        assertEq(vault.rejectionCount(), 1);
        assertEq(vault.getRejection(0).actor, owner);
    }

    function test_logRejection_stranger_blocked() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__NotAuthorizedToLog.selector, stranger));
        vault.logRejection(bytes32(0), 0);
        assertEq(vault.rejectionCount(), 0);
    }

    /// @dev A PAUSED agent's blocked attempts are exactly the evidence you
    ///      want — logging stays available during a kill switch.
    function test_logRejection_works_while_agent_paused() public {
        vm.prank(owner);
        vault.pauseAgent();

        vm.prank(agent);
        vault.logRejection(
            keccak256("attempted transfer while paused"), uint8(AegisVault.RejectionCategory.AgentInactive)
        );
        assertEq(vault.rejectionCount(), 1);
    }

    /// @dev Owner rejections of queued proposals are auto-logged — no extra
    ///      transaction needed for the audit trail.
    function test_rejectTx_auto_logs_to_rejection_ledger() public {
        vm.prank(agent);
        vault.submitForApproval(address(usdc), supplier, 1200e6, 15, "invoice INV-2041");

        vm.prank(owner);
        vault.rejectTx(1);

        assertEq(vault.rejectionCount(), 1);
        AegisVault.Rejection memory rej = vault.getRejection(0);
        assertEq(rej.actor, owner);
        assertEq(rej.reasonHash, keccak256(bytes("invoice INV-2041")));
        assertEq(rej.category, uint8(AegisVault.RejectionCategory.OwnerRejected));
    }

    function test_getRejection_out_of_range_reverts() public {
        vm.prank(agent);
        vault.logRejection(bytes32(uint256(0x42)), 0);
        vm.expectRevert(); // require() string revert
        vault.getRejection(1);
    }

    /// @dev The rejection ledger cannot be double-written through rejectTx:
    ///      terminal states (Rejected/Executed) refuse a second decision.
    function test_rejectTx_on_terminal_state_reverts() public {
        vm.prank(agent);
        vault.submitForApproval(address(usdc), supplier, 100e6, 5, "x");
        vm.startPrank(owner);
        vault.rejectTx(1);
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__TxNotRejectable.selector, 1, uint8(AegisVault.TxStatus.Rejected))
        );
        vault.rejectTx(1);
        vm.stopPrank();
        assertEq(vault.rejectionCount(), 1, "no duplicate ledger entry");
    }

    /// @dev The venue accepts plain ETH sends as inventory funding.
    function test_venue_receive_accepts_eth_inventory() public {
        vm.deal(stranger, 1 ether);
        (bool ok,) = address(venue).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(address(venue).balance, 501 ether, "inventory funded");
    }

    // ================================================================
    // 4. rationaleHash — indexed keccak256(reason) on agent events
    // ================================================================

    function test_events_carry_indexed_rationale_hash() public {
        string memory r = "Story 1: sweep with attested rationale";

        vm.expectEmit();
        emit AegisVault.AgentExecuted(
            vault.seq() + 1,
            address(usdc),
            savings,
            300e6,
            300e6,
            r,
            keccak256(bytes(r)) // <- the attested hash, computed independently here
        );
        vm.prank(agent);
        vault.agentExecute(address(usdc), savings, 300e6, r);

        vm.expectEmit();
        emit AegisVault.TxQueued(1, address(usdc), supplier, 1200e6, 15, r, keccak256(bytes(r)));
        vm.prank(agent);
        vault.submitForApproval(address(usdc), supplier, 1200e6, 15, r);
    }
}
