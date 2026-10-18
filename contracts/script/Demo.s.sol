// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AegisVault} from "../src/AegisVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockSwap} from "../src/mocks/MockSwap.sol";

/**
 * @notice Aegis Wallet — Checkpoint 1 (+ CP1.1 hardening) acceptance demo.
 *
 * Runs ALL FIVE user stories against a REAL chain (local anvil by default)
 * in four phases that mirror the product architecture:
 *
 *   PHASE 1  AGENT ACTIONS      — the AI acts autonomously inside policy:
 *                                 transfers, approval-queue proposals, a
 *                                 fixed-rate swap (CP1.1) and an on-chain
 *                                 rejection-ledger entry (CP1.1)
 *   PHASE 2  GUARDRAIL AUDIT    — attempts the chain itself REFUSES, with
 *                                 decoded on-chain error reasons, including
 *                                 the window-blocked swap (unified
 *                                 accounting) and the minOut slippage guard
 *   PHASE 3  HUMAN-IN-THE-LOOP  — approval queue execution, owner rejection
 *                                 (auto-logged to the rejection ledger),
 *                                 kill switch
 *   PHASE 4  OWNER SOVEREIGNTY  — the recovery path that has no limits
 *
 * Implementation note (why this structure): all REAL agent transactions are
 * broadcast in one contiguous block BEFORE any simulated (pranked) agent
 * attempt — pranked calls consume the broadcaster's per-key nonce slots, so
 * interleaving them with broadcast segments breaks nonce accounting. The
 * expected-revert attempts below are simulations against the same live state,
 * which is exactly what a dashboard will show users before they confirm.
 *
 * Usage (or just `make demo`):
 *   anvil &
 *   OWNER_KEY=0xac09... AGENT_KEY=0x59c6... \
 *     forge script script/Demo.s.sol --rpc-url http://localhost:8545 --broadcast --slow -vvv
 */
contract Demo is Script {
    AegisVault vault;
    MockUSDC usdc;
    MockSwap venue;

    address owner;
    address agent;
    address savings; // Sarah's savings wallet          (Story 1)
    address supplier; // Ahmed's design supplier        (Story 2)
    address attacker; // unknown / hallucinated address (Story 4)
    address anyone; // arbitrary non-whitelisted address

    uint256 constant USDC_CAP_PER_TX = 1000e6;
    uint256 constant USDC_DAILY = 1500e6;
    uint256 constant SWAP_USDC = 200e6; // Story 3 rebalance size
    uint256 constant SWAP_MIN_OUT = 0.049 ether; // expected 0.05 ETH

    uint256 guardrailFailures;

    function run() external {
        uint256 ownerKey = vm.envUint("OWNER_KEY");
        uint256 agentKey = vm.envUint("AGENT_KEY");
        owner = vm.addr(ownerKey);
        agent = vm.addr(agentKey);
        savings = makeAddr("savings");
        supplier = makeAddr("supplier");
        attacker = makeAddr("attacker");
        anyone = makeAddr("anyone");

        vm.label(owner, "Owner(Sarah/Ahmed)");
        vm.label(agent, "AegisAgent");
        vm.label(savings, "SavingsWallet");
        vm.label(supplier, "DesignSupplier");
        vm.label(attacker, "UnknownAddress");

        _banner("AEGIS WALLET - CHECKPOINT 1 + CP1.1 HARDENING DEMO (real chain, real guardrails)");

        // ==================================================================
        // SETUP (owner broadcast): deploy, fund, configure guardrails
        // ==================================================================
        vm.startBroadcast(ownerKey);
        usdc = new MockUSDC();
        venue = new MockSwap();
        vault = new AegisVault(agent);
        usdc.mint(owner, 5_000e6);
        usdc.approve(address(vault), type(uint256).max);
        vault.depositERC20(address(usdc), 3_000e6); // fund the vault
        vault.deposit{value: 5 ether}(); // ETH for swaps + fees
        vault.setWhitelist(savings, "Savings Wallet", true);
        vault.setWhitelist(supplier, "Acme Design Ltd (supplier)", true);
        vault.setTokenPolicy(address(usdc), USDC_CAP_PER_TX, USDC_DAILY);
        vault.setSwapVenue(address(venue)); // CP1.1: owner-trusted swap venue
        venue.setRate(address(usdc), address(0), 1 ether, 4_000e6); // $4,000/ETH
        payable(address(venue)).transfer(10 ether); // venue ETH inventory (real tx)
        vm.stopBroadcast();

        _say("SETUP", "MockUSDC + MockSwap + AegisVault deployed; vault funded 3,000 USDC + 5 ETH;");
        _say("SETUP", "whitelist = [Savings Wallet, Acme Design Ltd];");
        _say("SETUP", "USDC policy: max 1,000 USDC per agent tx / 1,500 USDC per ROLLING 24h window;");
        _say("SETUP", "swap venue: MockSwap at a fixed $4,000/ETH rate with minOut floor.");

        // ==================================================================
        // PHASE 1 — AGENT ACTIONS (autonomous, all inside policy)
        // ==================================================================
        _banner("PHASE 1 - AGENT ACTIONS (autonomous, inside policy)");
        vm.startBroadcast(agentKey);
        vault.agentExecute(
            address(usdc), savings, 800e6, "Story 1: Monday sweep - keep 200 in spending, move 800 to savings"
        );
        console2.log(
            string.concat(
                "[OK] Story 1 (Sarah): auto-swept 800 USDC to Savings Wallet",
                "  [savings=",
                _usdc(usdc.balanceOf(savings)),
                "]"
            )
        );

        vault.agentExecute(address(usdc), supplier, 300e6, "Story 2a: invoice INV-2033, within policy");
        console2.log("[OK] Story 2a (Ahmed): auto-paid 300 USDC invoice to supplier");

        vault.submitForApproval(
            address(usdc),
            supplier,
            1200e6,
            15, // riskScore 0-100 (dashboard shows "Low")
            "Story 2b: invoice INV-2041 for 1,200 USDC exceeds per-tx policy - please approve"
        );

        vault.submitForApproval(
            address(usdc),
            supplier,
            100e6,
            8,
            "Story 2c: invoice INV-2050 for 100 USDC - flagged as duplicate by the risk engine"
        );

        // CP1.1 — agent swap through the owner-set venue (unified accounting)
        vault.agentSwap(
            address(usdc),
            address(0), // buy native ETH
            SWAP_USDC,
            SWAP_MIN_OUT,
            "Story 3: rebalance - sell 200 USDC for ETH at $4,000 (minOut 0.049 ETH)"
        );
        console2.log(
            string.concat(
                "[OK] Story 3 (portfolio): swapped 200 USDC -> 0.05 ETH,",
                "  [vault ETH=",
                _eth(address(vault).balance),
                "]"
            )
        );

        // CP1.1 — rejection ledger: the agent's policy pre-check refused a
        // sweep this morning; it records the refusal on-chain as evidence.
        vault.logRejection(
            keccak256("pre-check refused: sweep 400 USDC - rolling window would exceed 1,500 cap"),
            uint8(AegisVault.RejectionCategory.CapWindow)
        );
        console2.log("[OK] Rejection ledger: agent logged its off-chain policy refusal (CapWindow)");
        vm.stopBroadcast();

        AegisVault.PendingTx memory t = vault.getTx(1);
        _ok(
            "Story 2b (Ahmed)",
            "1,200 USDC invoice routed to the APPROVAL QUEUE (nothing moved)",
            string.concat(
                "tx id 1: amount=",
                _usdc(t.amount),
                ", riskScore=",
                vm.toString(uint256(t.riskScore)),
                "/100, status=",
                _txStatus(t.status)
            )
        );
        console2.log(
            string.concat(
                "[note] agent spend in the rolling 24h window: ",
                _usdc(vault.spentInWindow(address(usdc))),
                " / 1,500 (800 sweep + 300 invoice + 200 swap sell)"
            )
        );

        // ==================================================================
        // PHASE 2 — GUARDRAIL AUDIT (attempts the chain REFUSES)
        //          simulated from the agent's perspective against live state
        // ==================================================================
        _banner("PHASE 2 - GUARDRAIL AUDIT (the chain itself says NO)");

        vm.prank(agent);
        try vault.agentExecute(address(usdc), savings, 800e6, "Story 1b: another sweep today") {
            _guardrailFail("rolling window cap");
        } catch (bytes memory err) {
            _blocked("Story 1b (Sarah)", "another 800 USDC sweep in the same 24h window", _revertName(err));
            _say("why", "1,300 already in the rolling window; +800 more = 2,100 > 1,500 cap.");
            _say("why", "CP1.1: entries expire exactly 24h after they are spent (no midnight reset).");
        }

        vm.prank(agent);
        try vault.agentExecute(address(usdc), attacker, 500e6, "Story 4: hallucinated recipient") {
            _guardrailFail("whitelist");
        } catch (bytes memory err) {
            _blocked("Story 4 (AI mistake)", "500 USDC to an address NOT on the whitelist", _revertName(err));
            _say("why", "The whitelist is an absolute on-chain floor - it applies to the agent");
            _say("why", "no matter what the AI 'decides'. Funds never left the vault:");
            _say("vault", string.concat("vault USDC balance still = ", _usdc(usdc.balanceOf(address(vault)))));
        }

        vm.prank(agent);
        try vault.agentExecute(address(usdc), supplier, 1200e6, "Story 2b: try to auto-pay 1,200") {
            _guardrailFail("per-tx cap");
        } catch (bytes memory err) {
            _blocked("Story 2b (Ahmed)", "direct auto-pay of the 1,200 USDC invoice", _revertName(err));
            _say("why", "That is exactly why the agent had to use the approval queue above.");
        }

        // CP1.1 — the swap path shares the rolling window with transfers
        vm.prank(agent);
        try vault.agentSwap(address(usdc), address(0), 300e6, 0, "try to bypass caps via swap") {
            _guardrailFail("unified window accounting");
        } catch (bytes memory err) {
            _blocked("window bypass attempt", "swap 300 USDC to route around the spend cap", _revertName(err));
            _say("why", "CP1.1 unified accounting: swaps consume the SAME rolling window");
            _say("why", "as transfers on the sell-side asset - there is no swap-shaped bypass.");
        }

        // CP1.1 — the minOut slippage guard
        vm.prank(agent);
        try vault.agentSwap(address(usdc), address(0), 100e6, 1 ether, "demand 1 ETH for 100 USDC") {
            _guardrailFail("minOut slippage guard");
        } catch (bytes memory err) {
            _blocked("slippage attempt", "swap 100 USDC demanding 1 ETH out (rate says 0.025)", _revertName(err));
            _say("why", "The venue enforces minOut; a bad fill reverts the WHOLE transaction");
            _say("why", "and the window entry rolls back - nothing is spent on a bad price.");
        }

        // ==================================================================
        // PHASE 3 — HUMAN-IN-THE-LOOP + KILL SWITCH (owner broadcast)
        // ==================================================================
        _banner("PHASE 3 - HUMAN-IN-THE-LOOP + KILL SWITCH");
        vm.startBroadcast(ownerKey);
        vault.approveTx(1); // Ahmed signs off in the dashboard
        vault.executeApprovedTx(1); // and executes — human-authorized
        vault.rejectTx(2); // duplicate invoice declined — auto-logged (CP1.1)
        vault.pauseAgent();
        vm.stopBroadcast();

        _ok(
            "Story 2b (Ahmed)",
            "owner approved + executed -> supplier received the 1,200 USDC",
            string.concat(
                "supplier=",
                _usdc(usdc.balanceOf(supplier)),
                ", agent window still ",
                _usdc(vault.spentInWindow(address(usdc))),
                " (human-approved = exempt from agent caps)"
            )
        );
        _ok(
            "Rejection ledger (CP1.1)",
            "owner REJECTED the duplicate invoice - decision auto-logged on-chain",
            string.concat(
                "rejection entries: ",
                vm.toString(vault.rejectionCount()),
                " (1 agent pre-check refusal + 1 owner rejection)"
            )
        );
        _ok("Story 5 (kill switch)", "owner PAUSED the agent with one transaction", "");

        vm.prank(agent);
        try vault.agentExecute(address(usdc), savings, 100e6, "Story 5: while paused") {
            _guardrailFail("pause");
        } catch (bytes memory err) {
            _blocked("Story 5", "agent transfer while paused", _revertName(err));
        }

        vm.prank(agent);
        try vault.submitForApproval(address(usdc), savings, 100e6, 10, "Story 5: propose while paused") {
            _guardrailFail("pause");
        } catch (bytes memory err) {
            _blocked("Story 5", "even the approval queue is frozen while paused", _revertName(err));
        }

        vm.startBroadcast(ownerKey);
        vault.revokeAgent();
        vm.stopBroadcast();
        _ok("Story 5 (kill switch)", "owner REVOKED the agent (sticky: no resume path)", "");

        vm.prank(agent);
        try vault.agentExecute(address(usdc), savings, 100e6, "Story 5: after revoke") {
            _guardrailFail("revoke");
        } catch (bytes memory err) {
            _blocked("Story 5", "agent transfer after revocation", _revertName(err));
        }
        _say("why", "Only an explicit owner `setAgent` can ever re-grant access.");

        // ==================================================================
        // PHASE 4 — OWNER SOVEREIGNTY (the recovery path always works)
        // ==================================================================
        _banner("PHASE 4 - OWNER SOVEREIGNTY (no limits for the owner)");
        vm.startBroadcast(ownerKey);
        vault.ownerWithdraw(address(usdc), anyone, 50e6); // non-whitelisted, beyond agent caps — fine
        vault.ownerWithdraw(address(0), anyone, 0.01 ether); // the swapped ETH is recoverable too
        vm.stopBroadcast();
        _ok(
            "recovery",
            "owner withdrew 50 USDC + 0.01 ETH to a non-whitelisted address",
            "it is the user's money; every owner action is event-logged"
        );

        // ==================================================================
        // SUMMARY
        // ==================================================================
        _banner("DEMO SUMMARY");
        console2.log(string.concat("vault USDC balance : ", _usdc(usdc.balanceOf(address(vault)))));
        console2.log(string.concat("vault ETH balance  : ", _eth(address(vault).balance)));
        console2.log(string.concat("savings received   : ", _usdc(usdc.balanceOf(savings))));
        console2.log(string.concat("supplier received  : ", _usdc(usdc.balanceOf(supplier))));
        console2.log(
            string.concat("agent window spend : ", _usdc(vault.spentInWindow(address(usdc))), " / 1,500 rolling 24h")
        );
        (uint256 liveEntries, uint256 capacity) = vault.windowState(address(usdc));
        console2.log(
            string.concat(
                "window ring buffer : ",
                vm.toString(liveEntries),
                "/",
                vm.toString(capacity),
                " live entries (fails closed if full)"
            )
        );
        console2.log(string.concat("rejection ledger   : ", vm.toString(vault.rejectionCount()), " entries"));
        console2.log(
            string.concat(
                "agent status       : ",
                vm.toString(uint8(vault.agentStatus())),
                " (0=None 1=Active 2=Paused 3=Revoked)"
            )
        );
        console2.log("guardrail actions  :", vault.seq());
        if (guardrailFailures == 0) {
            console2.log("RESULT             : ALL GUARDRAILS HELD - CHECKPOINT 1 + CP1.1 PASSED");
        } else {
            console2.log(
                string.concat(
                    "RESULT             : ", vm.toString(guardrailFailures), " GUARDRAIL(S) BYPASSED - FAILED"
                )
            );
            revert("Guardrail unexpectedly bypassed");
        }
    }

    // ------------------------------------------------------------------
    // Console helpers
    // ------------------------------------------------------------------

    function _banner(string memory title) internal view {
        console2.log("");
        console2.log("==============================================================");
        console2.log(title);
        console2.log("==============================================================");
    }

    function _say(string memory tag, string memory msg) internal view {
        console2.log(string.concat("[", tag, "] ", msg));
    }

    function _ok(string memory tag, string memory what, string memory detail) internal view {
        console2.log(string.concat("[OK] ", tag, ": ", what));
        if (bytes(detail).length > 0) console2.log(string.concat("     ", detail));
    }

    function _blocked(string memory tag, string memory what, string memory reason) internal view {
        console2.log(string.concat("[BLOCKED] ", tag, ": ", what));
        console2.log(string.concat("     chain says: ", reason));
    }

    function _guardrailFail(string memory which) internal {
        guardrailFailures += 1;
        console2.log(string.concat("[!!FAIL!!] guardrail did NOT hold: ", which));
    }

    function _txStatus(AegisVault.TxStatus s) internal pure returns (string memory) {
        if (s == AegisVault.TxStatus.Queued) return "Queued (WaitingApproval)";
        if (s == AegisVault.TxStatus.Approved) return "Approved";
        if (s == AegisVault.TxStatus.Rejected) return "Rejected";
        return "Executed";
    }

    function _usdc(uint256 amount) internal view returns (string memory) {
        return string.concat(vm.toString(amount / 1e6), " USDC");
    }

    /// @dev ETH with 3 decimals, e.g. 5050000000000000000 -> "5.050 ETH".
    function _eth(uint256 amount) internal view returns (string memory) {
        uint256 whole = amount / 1e18;
        uint256 frac = (amount % 1e18) / 1e15; // milli-ETH 0..999
        string memory f = vm.toString(frac);
        if (frac < 10) {
            f = string.concat("00", f);
        } else if (frac < 100) {
            f = string.concat("0", f);
        }
        return string.concat(vm.toString(whole), ".", f, " ETH");
    }

    // ------------------------------------------------------------------
    // Custom-error decoder (so the console shows WHY the chain said no)
    // ------------------------------------------------------------------

    function _sel(bytes memory b) internal pure returns (bytes4 s) {
        require(b.length >= 4, "short revert data");
        assembly {
            s := and(mload(add(b, 32)), 0xffffffff00000000000000000000000000000000000000000000000000000000)
        }
    }

    /// @dev bytes-memory slicing (solc only supports calldata slicing natively).
    function _slice(bytes memory b, uint256 start) internal pure returns (bytes memory out) {
        require(b.length >= start, "short revert data");
        out = new bytes(b.length - start);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = b[start + i];
        }
    }

    function _revertName(bytes memory b) internal view returns (string memory) {
        if (b.length < 4) return string(b);
        bytes4 s = _sel(b);
        bytes memory args = _slice(b, 4);

        if (s == bytes4(keccak256("Aegis__AgentPaused()"))) return "Aegis__AgentPaused";
        if (s == bytes4(keccak256("Aegis__AgentRevoked()"))) return "Aegis__AgentRevoked";
        if (s == bytes4(keccak256("Aegis__NotAgent(address)"))) {
            address c;
            (c) = abi.decode(args, (address));
            return string.concat("Aegis__NotAgent(caller=", vm.toString(c), ")");
        }
        if (s == bytes4(keccak256("Aegis__RecipientNotWhitelisted(address)"))) {
            address r;
            (r) = abi.decode(args, (address));
            return string.concat("Aegis__RecipientNotWhitelisted(recipient=", vm.toString(r), ")");
        }
        if (s == bytes4(keccak256("Aegis__ExceedsPerTxLimit(address,uint256,uint256)"))) {
            uint256 req;
            uint256 cap;
            (, req, cap) = abi.decode(args, (address, uint256, uint256));
            return string.concat(
                "Aegis__ExceedsPerTxLimit(requested=",
                vm.toString(req / 1e6),
                " USDC, cap=",
                vm.toString(cap / 1e6),
                " USDC)"
            );
        }
        if (s == bytes4(keccak256("Aegis__ExceedsDailyLimit(address,uint256,uint256,uint256)"))) {
            uint256 spent;
            uint256 req;
            uint256 cap;
            (, spent, req, cap) = abi.decode(args, (address, uint256, uint256, uint256));
            return string.concat(
                "Aegis__ExceedsDailyLimit(spent=",
                vm.toString(spent / 1e6),
                " USDC, requested=",
                vm.toString(req / 1e6),
                " USDC, cap=",
                vm.toString(cap / 1e6),
                " USDC)"
            );
        }
        if (s == bytes4(keccak256("Aegis__DailyWindowUncertain(address)"))) {
            return "Aegis__DailyWindowUncertain (ring buffer full: window fails CLOSED)";
        }
        if (s == bytes4(keccak256("MockSwap__BelowMinOut(uint256,uint256)"))) {
            uint256 got;
            uint256 want;
            (got, want) = abi.decode(args, (uint256, uint256));
            return string.concat("MockSwap__BelowMinOut(would pay ", _eth(got), ", minOut ", _eth(want), ")");
        }
        if (s == bytes4(keccak256("Aegis__InsufficientBalance(address,uint256,uint256)"))) {
            uint256 have;
            uint256 need;
            (, have, need) = abi.decode(args, (address, uint256, uint256));
            return string.concat(
                "Aegis__InsufficientBalance(have=", vm.toString(have / 1e6), ", need=", vm.toString(need / 1e6), ")"
            );
        }
        return string.concat("unknown error, selector 0x", vm.toString(bytes32(s)));
    }
}
