// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {AegisVault} from "../src/AegisVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {BadToken, RejectingEther} from "./mocks/Mocks.sol";

/**
 * @dev The five Aegis user stories, tested end-to-end at the contract level.
 *
 *      Story 1 — Sarah: recurring auto-sweep inside per-tx/rolling-24h caps
 *      Story 2 — Ahmed: small invoice auto-pays, large invoice needs approval
 *      Story 4 — AI mistake: unknown recipient is absolutely blocked
 *      Story 5 — Kill switch: pause / revoke freezes the agent instantly
 *      (+ native ETH path, balance and rollback edge cases)
 *
 *      CP1.1: the daily ledger is now a ROLLING 24h window — spends count
 *      against the cap for exactly 24 hours after they happen, so the old
 *      "full cap before AND after midnight" boundary burst is closed.
 */
contract AegisVaultStoriesTest is BaseTest {
    string constant R = "Story 1: Monday sweep - keep 200 in spending, move 800 to savings";

    // ================================================================
    // STORY 1 — Sarah (rolling 24h window semantics)
    // ================================================================

    function test_story1_sweep_inside_all_limits() public {
        vm.expectEmit();
        emit AegisVault.AgentExecuted(vault.seq() + 1, address(usdc), savings, 800e6, 800e6, R, keccak256(bytes(R)));
        vm.prank(agent);
        vault.agentExecute(address(usdc), savings, 800e6, R);

        assertEq(usdc.balanceOf(savings), 800e6, "savings received 800");
        assertEq(vault.spentInWindow(address(usdc)), 800e6, "window ledger = 800");
    }

    function test_story1_second_sweep_exactly_at_window_cap_passes() public {
        _execute(savings, 800e6, R);
        _execute(savings, 700e6, R); // 800 + 700 = 1,500 == cap -> allowed
        assertEq(vault.spentInWindow(address(usdc)), DAILY);
    }

    function test_story1_third_sweep_exceeding_window_cap_blocked() public {
        _execute(savings, 800e6, R);
        _execute(savings, 700e6, R);

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__ExceedsDailyLimit.selector, address(usdc), DAILY, 1e6, DAILY)
        );
        vault.agentExecute(address(usdc), savings, 1e6, "one dollar too many");
        assertEq(vault.spentInWindow(address(usdc)), DAILY, "ledger unchanged after revert");
    }

    function test_story1_window_counts_spend_for_exactly_24_hours() public {
        _execute(savings, 800e6, R);
        assertEq(vault.spentInWindow(address(usdc)), 800e6);

        vm.warp(block.timestamp + 23 hours);
        assertEq(vault.spentInWindow(address(usdc)), 800e6, "still inside the 24h window");

        vm.warp(block.timestamp + 1 hours + 1 seconds); // > 24h after the spend
        assertEq(vault.spentInWindow(address(usdc)), 0, "spend expired after 24h");
    }

    function test_story1_cap_frees_exactly_24h_after_the_spend() public {
        _execute(savings, 800e6, R);

        vm.warp(block.timestamp + 24 hours); // exactly 24h later: expired
        assertEq(vault.spentInWindow(address(usdc)), 0, "entry expired at exactly 24h");

        _execute(savings, 700e6, R); // fresh capacity available
        assertEq(vault.spentInWindow(address(usdc)), 700e6);
    }

    function test_story1_staggered_spends_expire_independently() public {
        _execute(savings, 800e6, R); // T0
        vm.warp(block.timestamp + 1 hours);
        _execute(savings, 700e6, R); // T0+1h
        assertEq(vault.spentInWindow(address(usdc)), 1500e6);

        vm.warp(block.timestamp + 23 hours + 30 minutes); // T0+24h30m: first expired, second (age 23h30m) still live
        assertEq(vault.spentInWindow(address(usdc)), 700e6);

        // capacity for 800 more, but not one unit past the cap
        _execute(savings, 800e6, R);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__ExceedsDailyLimit.selector, address(usdc), DAILY, 1e6, DAILY)
        );
        vault.agentExecute(address(usdc), savings, 1e6, "nope");
    }

    /**
     * @dev THE CP1.1 acceptance test: the old UTC-day ledger allowed a full
     *      cap right before midnight AND another full cap right after — a 2x
     *      exposure in minutes. The rolling window closes it: nothing resets
     *      at midnight; spends keep counting for 24 hours after they happen.
     */
    function test_story1_boundary_burst_across_midnight_is_closed() public {
        // Park the clock at noon UTC so we can approach a real midnight.
        uint256 noon = 1_767_225_600 + 12 hours; // 2026-01-01 12:00 UTC
        uint256 midnight = noon + 12 hours;
        vm.warp(noon);

        _execute(savings, 800e6, R);
        _execute(savings, 700e6, R); // window = 1,500 = full cap at 12:00

        // 23:59 same day — still blocked (12h59m after the spends)
        vm.warp(midnight - 1 minutes);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__ExceedsDailyLimit.selector, address(usdc), DAILY, 1e6, DAILY)
        );
        vault.agentExecute(address(usdc), savings, 1e6, "try just before midnight");

        // 00:01 next day — the OLD ledger reset here; the rolling window does not
        vm.warp(midnight + 1 minutes);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__ExceedsDailyLimit.selector, address(usdc), DAILY, 1e6, DAILY)
        );
        vault.agentExecute(address(usdc), savings, 1e6, "try just after midnight");

        assertEq(vault.spentInWindow(address(usdc)), DAILY, "nothing reset at midnight");

        // only when the spends are 24h old does capacity return (both spent at noon)
        vm.warp(noon + 24 hours + 1 seconds);
        _execute(savings, 800e6, R);
        assertEq(vault.spentInWindow(address(usdc)), 800e6, "full capacity returned 24h later");
    }

    function testFuzz_story1_per_tx_cap_blocks_any_amount_above(uint256 amount) public {
        vm.assume(amount > CAP_PER_TX);
        vm.assume(amount <= VAULT_FUNDS); // isolate the per-tx check from the balance check
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__ExceedsPerTxLimit.selector, address(usdc), amount, CAP_PER_TX)
        );
        vault.agentExecute(address(usdc), savings, amount, "fuzz over per-tx");
    }

    // ================================================================
    // STORY 2 — Ahmed
    // ================================================================

    function test_story2a_small_invoice_auto_paid() public {
        string memory r = "Story 2a: invoice INV-2033";
        vm.expectEmit();
        emit AegisVault.AgentExecuted(vault.seq() + 1, address(usdc), supplier, 300e6, 300e6, r, keccak256(bytes(r)));
        _execute(supplier, 300e6, r);
        assertEq(usdc.balanceOf(supplier), 300e6);
    }

    function test_story2b_large_invoice_cannot_auto_execute() public {
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__ExceedsPerTxLimit.selector, address(usdc), 1200e6, CAP_PER_TX)
        );
        vault.agentExecute(address(usdc), supplier, 1200e6, "Story 2b: try auto-pay");
    }

    function test_story2b_queue_submit_stores_the_proposal() public {
        string memory r = "Story 2b: invoice INV-2041 needs approval";
        vm.expectEmit();
        emit AegisVault.TxQueued(1, address(usdc), supplier, 1200e6, 15, r, keccak256(bytes(r)));
        vm.prank(agent);
        vault.submitForApproval(address(usdc), supplier, 1200e6, 15, r);

        AegisVault.PendingTx memory t = vault.getTx(1);
        assertEq(t.to, supplier);
        assertEq(t.amount, 1200e6);
        assertEq(t.riskScore, 15);
        assertEq(t.proposedBy, agent);
        assertEq(uint8(t.status), uint8(AegisVault.TxStatus.Queued));
        assertEq(vault.queueLength(), 1);
        assertEq(usdc.balanceOf(supplier), 0, "nothing moved yet");
    }

    function test_story2b_approve_then_execute_full_lifecycle() public {
        vm.prank(agent);
        vault.submitForApproval(address(usdc), supplier, 1200e6, 15, "invoice INV-2041");

        vm.prank(owner);
        vault.approveTx(1);
        assertEq(uint8(vault.getTx(1).status), uint8(AegisVault.TxStatus.Approved));
        assertEq(usdc.balanceOf(supplier), 0, "approval alone moves nothing");

        vm.expectEmit();
        emit AegisVault.ApprovedTxExecuted(1, address(usdc), supplier, 1200e6);
        vm.prank(owner);
        vault.executeApprovedTx(1);

        assertEq(usdc.balanceOf(supplier), 1200e6);
        assertEq(uint8(vault.getTx(1).status), uint8(AegisVault.TxStatus.Executed));
        // human-approved execution is EXEMPT from the agent window
        assertEq(vault.spentInWindow(address(usdc)), 0, "agent ledger untouched");
    }

    function test_story2b_reject_leaves_funds_in_vault() public {
        vm.prank(agent);
        vault.submitForApproval(address(usdc), supplier, 1200e6, 15, "invoice INV-2041");

        vm.prank(owner);
        vault.rejectTx(1);
        assertEq(uint8(vault.getTx(1).status), uint8(AegisVault.TxStatus.Rejected));

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__TxNotApproved.selector, 1, uint8(AegisVault.TxStatus.Rejected))
        );
        vault.executeApprovedTx(1);
        assertEq(usdc.balanceOf(supplier), 0);
    }

    function test_story2b_double_approve_reverts() public {
        vm.prank(agent);
        vault.submitForApproval(address(usdc), supplier, 1200e6, 15, "x");
        vm.startPrank(owner);
        vault.approveTx(1);
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__TxNotQueued.selector, 1, uint8(AegisVault.TxStatus.Approved))
        );
        vault.approveTx(1);
        vm.stopPrank();
    }

    function test_story2b_reject_after_approve_is_allowed() public {
        vm.prank(agent);
        vault.submitForApproval(address(usdc), supplier, 1200e6, 15, "x");
        vm.startPrank(owner);
        vault.approveTx(1);
        vault.rejectTx(1); // owner backs out
        vm.stopPrank();
        assertEq(uint8(vault.getTx(1).status), uint8(AegisVault.TxStatus.Rejected));
    }

    function test_story2b_execution_rechecks_whitelist() public {
        vm.prank(agent);
        vault.submitForApproval(address(usdc), supplier, 1200e6, 15, "x");
        vm.startPrank(owner);
        vault.approveTx(1);
        vault.setWhitelist(supplier, "", false); // delisted between approve and execute
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__RecipientNotWhitelisted.selector, supplier));
        vault.executeApprovedTx(1);
        vm.stopPrank();

        assertEq(uint8(vault.getTx(1).status), uint8(AegisVault.TxStatus.Approved), "status preserved");
        assertEq(usdc.balanceOf(supplier), 0, "no funds moved");
    }

    function test_story2_queue_frozen_while_paused() public {
        vm.prank(owner);
        vault.pauseAgent();
        vm.prank(agent);
        vm.expectRevert(AegisVault.Aegis__AgentPaused.selector);
        vault.submitForApproval(address(usdc), supplier, 300e6, 10, "x");
    }

    // ================================================================
    // STORY 4 — AI mistake protection
    // ================================================================

    function test_story4_unknown_recipient_blocked_zero_loss() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__RecipientNotWhitelisted.selector, unknown));
        vault.agentExecute(address(usdc), unknown, 500e6, "Story 4: hallucinated recipient");

        assertEq(usdc.balanceOf(unknown), 0, "attacker got nothing");
        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS, "vault untouched");
        assertEq(vault.spentInWindow(address(usdc)), 0, "window ledger untouched");
    }

    function test_story4_whitelist_is_absolute_even_for_tiny_amounts() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__RecipientNotWhitelisted.selector, unknown));
        vault.agentExecute(address(usdc), unknown, 1, "even 1 unit");
    }

    function test_story4_queue_path_also_requires_whitelist() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__RecipientNotWhitelisted.selector, unknown));
        vault.submitForApproval(address(usdc), unknown, 1200e6, 10, "try to queue it");
        assertEq(vault.queueLength(), 0);
    }

    // ================================================================
    // STORY 5 — Kill switch
    // ================================================================

    function test_story5_pause_blocks_everything_agent_side() public {
        vm.prank(owner);
        vault.pauseAgent();

        vm.prank(agent);
        vm.expectRevert(AegisVault.Aegis__AgentPaused.selector);
        vault.agentExecute(address(usdc), savings, 300e6, "while paused");

        vm.prank(agent);
        vm.expectRevert(AegisVault.Aegis__AgentPaused.selector);
        vault.submitForApproval(address(usdc), savings, 300e6, 10, "while paused");

        // owner path keeps working
        vm.prank(owner);
        vault.ownerWithdraw(address(usdc), owner, 100e6);
    }

    function test_story5_resume_restores_agent() public {
        vm.startPrank(owner);
        vault.pauseAgent();
        vault.resumeAgent();
        vm.stopPrank();

        _execute(savings, 300e6, R); // works again
        assertEq(usdc.balanceOf(savings), 300e6);
    }

    function test_story5_revoke_is_sticky() public {
        vm.startPrank(owner);
        vault.pauseAgent();
        vault.revokeAgent();

        // resume cannot rescue a revoked agent
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__InvalidAgentStatus.selector, uint8(AegisVault.AgentStatus.Revoked))
        );
        vault.resumeAgent();
        vm.stopPrank();

        vm.prank(agent);
        vm.expectRevert(AegisVault.Aegis__AgentRevoked.selector);
        vault.agentExecute(address(usdc), savings, 300e6, "after revoke");

        // only an explicit setAgent re-grants access
        vm.prank(owner);
        vault.setAgent(agent);
        _execute(savings, 300e6, "re-granted");
        assertEq(usdc.balanceOf(savings), 300e6);
    }

    function test_story5_setAgent_rotates_the_key() public {
        address newAgent = makeAddr("newAgent");
        vm.prank(owner);
        vault.setAgent(newAgent);

        vm.prank(agent); // old key is dead
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__NotAgent.selector, agent));
        vault.agentExecute(address(usdc), savings, 300e6, "old key");

        vm.prank(newAgent); // new key works
        vault.agentExecute(address(usdc), savings, 300e6, "new key");
        assertEq(usdc.balanceOf(savings), 300e6);
    }

    function test_story5_revoke_requires_agent_to_exist() public {
        vm.startPrank(owner);
        AegisVault bare = new AegisVault(address(0));
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__InvalidAgentStatus.selector, uint8(AegisVault.AgentStatus.None))
        );
        bare.revokeAgent();
        vm.stopPrank();
    }

    // ================================================================
    // Native ETH path + rollback edge cases
    // ================================================================

    function test_agent_native_eth_flow() public {
        vm.prank(agent);
        vault.agentExecute(address(0), savings, 0.5 ether, "ETH sweep");

        assertEq(savings.balance, 0.5 ether);
        assertEq(vault.spentInWindow(address(0)), 0.5 ether);
        assertEq(vault.spentInWindow(address(usdc)), 0, "windows are per-asset");
    }

    function test_agent_native_eth_reverting_receiver_rolls_back() public {
        RejectingEther sink = new RejectingEther();
        vm.startPrank(owner);
        vault.setWhitelist(address(sink), "stubborn", true);
        vm.stopPrank();

        vm.prank(agent);
        vm.expectRevert(AegisVault.Aegis__EthTransferFailed.selector);
        vault.agentExecute(address(0), address(sink), 0.5 ether, "will fail");

        assertEq(vault.spentInWindow(address(0)), 0, "window rolled back");
        assertEq(address(vault).balance, VAULT_ETH);
    }

    function test_native_window_cap_enforced() public {
        vm.startPrank(agent);
        vault.agentExecute(address(0), savings, 1 ether, "first");
        vault.agentExecute(address(0), savings, 1 ether, "second"); // exactly at cap
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__ExceedsDailyLimit.selector, address(0), 2 ether, 1, 2 ether)
        );
        vault.agentExecute(address(0), savings, 1, "third");
        vm.stopPrank();
    }

    function test_insufficient_balance_reverts_cleanly() public {
        // drain almost everything so the balance check fires while the
        // per-tx and window checks still pass
        vm.startPrank(owner);
        vault.ownerWithdraw(address(usdc), owner, VAULT_FUNDS - 100e6);
        vm.stopPrank();

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AegisVault.Aegis__InsufficientBalance.selector, address(usdc), 100e6, 200e6)
        );
        vault.agentExecute(address(usdc), savings, 200e6, "not enough in vault");
        assertEq(vault.spentInWindow(address(usdc)), 0, "ledger untouched");
    }

    function test_bad_token_failure_rolls_back_window_ledger() public {
        BadToken bad = new BadToken(false);
        vm.startPrank(owner);
        bad.setBalance(address(vault), 1_000e6);
        vault.setWhitelist(savings, "Savings Wallet", true);
        vault.setTokenPolicy(address(bad), 500e6, 1_000e6);
        vm.stopPrank();

        vm.prank(agent);
        vm.expectRevert(); // SafeERC20 rejects the false-returning token
        vault.agentExecute(address(bad), savings, 300e6, "bad token");

        assertEq(vault.spentInWindow(address(bad)), 0, "window rolled back");
    }

    function test_stranger_cannot_act_as_agent() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__NotAgent.selector, stranger));
        vault.agentExecute(address(usdc), savings, 300e6, "not the agent");
    }
}
