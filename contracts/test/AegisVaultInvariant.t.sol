// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {AegisVault} from "../src/AegisVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockSwap} from "../src/mocks/MockSwap.sol";

/**
 * @dev Stateful fuzz (invariant) harness — CP1.1 edition.
 *
 *      The Handler plays every role against the REAL vault:
 *        - as the agent: bounded auto-transfers, approval proposals,
 *          fixed-rate swaps through the MockSwap venue
 *        - as the owner: policy mutations, whitelist toggles, approvals,
 *          time warps (which expire rolling-window entries)
 *
 *      Ghost variables record what actually left/entered the vault, so the
 *      invariants prove, for every fuzzed sequence of actions:
 *
 *        1. the rolling-window ledger can never exceed the policy cap
 *        2. the contract's rolling window EXACTLY matches the ghost model
 *           of (timestamp, amount) spends — catches ring-buffer drift,
 *           wrong-order expiry and rollback bugs
 *        3. solvency: vault balances equal initial + swap buys - all
 *           outflows (agent + human-approved) — no funds created or lost
 */
contract Handler {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    AegisVault public vault;
    MockUSDC public usdc;
    MockSwap public venue;

    address[3] public recipients;
    address[2] public tokens;

    uint256 constant MAX_TX = 1e6; // per-tx cap used throughout the run
    uint256 constant MIN_DAILY = 3e6;

    // ---------------- ghosts ----------------
    struct GhostSpend {
        uint64 ts;
        uint128 amt;
    }
    GhostSpend[] public ghostSpendsUSDC; // agent USDC spends (transfers + swap sells)
    GhostSpend[] public ghostSpendsETH; // agent ETH spends
    mapping(address => uint256) public ghostTotalOut; // ALL outflows incl. approved
    mapping(address => uint256) public ghostTotalIn; // swap buys received by the vault

    constructor(MockUSDC usdc_, address[3] memory recipients_) {
        usdc = usdc_;
        recipients = recipients_;
        tokens = [address(usdc), address(0)];
    }

    function bind(AegisVault vault_, MockSwap venue_) external {
        require(address(vault) == address(0), "already bound");
        vault = vault_;
        venue = venue_;
    }

    /// @dev Initial configuration — called once by setUp (owner == handler).
    function setup() external {
        vault.setTokenPolicy(address(usdc), MAX_TX, MIN_DAILY);
        vault.setTokenPolicy(address(0), MAX_TX, MIN_DAILY);
        vault.setSwapVenue(address(venue));
        for (uint256 i = 0; i < 3; i++) {
            vault.setWhitelist(recipients[i], "fuzz recipient", true);
        }
        // fixed rates both ways: 1 USDC == 0.00025 ETH (i.e. $4,000 / ETH)
        venue.setRate(address(usdc), address(0), 1 ether, 4_000e6);
        venue.setRate(address(0), address(usdc), 4_000e6, 1 ether);
    }

    // ---------------- fuzz actors ----------------

    /// @dev Agent path: bounded amounts so the per-tx cap always passes —
    ///      the run focuses on the rolling window and rollback correctness.
    function agentExecute(uint8 tokenSel, uint8 toSel, uint104 amountRaw) external {
        address token = tokens[tokenSel % 2];
        address to = recipients[toSel % 3];
        uint256 amount = uint256(amountRaw) % (MAX_TX + 1);
        if (amount == 0) return;

        try vault.agentExecute(token, to, amount, "fuzz") {
            _recordSpend(token, amount);
            ghostTotalOut[token] += amount;
        } catch {
            // guardrail rejected (not whitelisted / window cap / buffer full) — allowed
        }
    }

    /// @dev Agent swap path, both directions. minOut = 0 so only the vault's
    ///      own guardrails (per-tx, window, buffer) can block it.
    function agentSwap(uint8 dir, uint104 amountRaw) external {
        address sellToken = dir % 2 == 0 ? address(usdc) : address(0);
        address buyToken = dir % 2 == 0 ? address(0) : address(usdc);
        uint256 amount = uint256(amountRaw) % (MAX_TX + 1);
        if (amount == 0) return;

        try vault.agentSwap(sellToken, buyToken, amount, 0, "fuzz swap") {
            _recordSpend(sellToken, amount);
            ghostTotalOut[sellToken] += amount;
            uint256 out = venue.quote(sellToken, buyToken, amount);
            ghostTotalIn[buyToken] += out;
        } catch {
            // guardrail rejected — allowed
        }
    }

    /// @dev Owner raises or lowers the cap, but never below the asset's
    ///      CURRENT window spend (the same rule the dashboard enforces).
    function setPolicy(uint8 tokenSel, uint8 dailySel) external {
        address token = tokens[tokenSel % 2];
        uint256 newDaily = MIN_DAILY + uint256(dailySel) * 1e5;
        uint256 spent = vault.spentInWindow(token);
        if (newDaily < spent) return;
        vault.setTokenPolicy(token, MAX_TX, newDaily);
    }

    function toggleWhitelist(uint8 sel) external {
        address who = recipients[sel % 3];
        vault.setWhitelist(who, "fuzz recipient", !vault.whitelisted(who));
    }

    function warp(uint16 hoursRaw) external {
        vm.warp(block.timestamp + 1 + (uint256(hoursRaw) % 48) * 1 hours);
    }

    /// @dev Full human-approval flow. MUST NOT touch the agent window
    ///      (invariant 2 catches it if it ever did).
    function approveFlow(uint8 toSel) external {
        address to = recipients[toSel % 3];
        if (!vault.whitelisted(to)) return;

        try vault.submitForApproval(address(usdc), to, 1e5, 5, "fuzz approval") {
            uint256 id = vault.queueLength();
            try vault.approveTx(id) {
                try vault.executeApprovedTx(id) {
                    ghostTotalOut[address(usdc)] += 1e5;
                } catch {}
            } catch {}
        } catch {}
    }

    // ---------------- ghost views ----------------

    function ghostSpendCountUSDC() external view returns (uint256) {
        return ghostSpendsUSDC.length;
    }

    function ghostSpendCountETH() external view returns (uint256) {
        return ghostSpendsETH.length;
    }

    function _recordSpend(address token, uint256 amount) internal {
        if (token == address(usdc)) {
            ghostSpendsUSDC.push(GhostSpend(uint64(block.timestamp), uint128(amount)));
        } else {
            ghostSpendsETH.push(GhostSpend(uint64(block.timestamp), uint128(amount)));
        }
    }
}

contract AegisVaultInvariantTest is Test {
    Handler handler;
    MockUSDC usdc;
    MockSwap venue;
    AegisVault vault;

    uint256 constant INITIAL_USDC = 1_000_000e6;
    uint256 constant INITIAL_ETH = 100 ether;
    uint256 constant VENUE_USDC = 500_000e6;
    uint256 constant VENUE_ETH = 500 ether;

    function setUp() public {
        usdc = new MockUSDC();
        address[3] memory recipients = [makeAddr("r0"), makeAddr("r1"), makeAddr("r2")];
        handler = new Handler(usdc, recipients);

        // the venue must be OWNED by the handler (setup() sets rates),
        // and the vault must be owned by it too, so it can play every role
        vm.prank(address(handler));
        venue = new MockSwap();
        vm.startPrank(address(handler));
        vault = new AegisVault(address(handler));
        vm.stopPrank();
        handler.bind(vault, venue);
        handler.setup();

        // fund the vault and the venue inventories
        usdc.mint(address(vault), INITIAL_USDC);
        vm.deal(address(vault), INITIAL_ETH);
        usdc.mint(address(venue), VENUE_USDC);
        vm.deal(address(venue), VENUE_ETH);

        // fuzzer targets
        targetContract(address(handler));
        FuzzSelector memory selectors = FuzzSelector({addr: address(handler), selectors: new bytes4[](6)});
        selectors.selectors[0] = Handler.agentExecute.selector;
        selectors.selectors[1] = Handler.setPolicy.selector;
        selectors.selectors[2] = Handler.toggleWhitelist.selector;
        selectors.selectors[3] = Handler.warp.selector;
        selectors.selectors[4] = Handler.approveFlow.selector;
        selectors.selectors[5] = Handler.agentSwap.selector;
        targetSelector(selectors);
    }

    /// @dev Ghost window model: sum of ghost spends younger than 24h.
    function _ghostWindow(address token) internal view returns (uint256 sum) {
        if (token == address(usdc)) {
            uint256 n = handler.ghostSpendCountUSDC();
            for (uint256 i = 0; i < n; i++) {
                (uint64 ts, uint128 amt) = handler.ghostSpendsUSDC(i);
                if (ts + 24 hours > block.timestamp) sum += amt;
            }
        } else {
            uint256 n = handler.ghostSpendCountETH();
            for (uint256 i = 0; i < n; i++) {
                (uint64 ts, uint128 amt) = handler.ghostSpendsETH(i);
                if (ts + 24 hours > block.timestamp) sum += amt;
            }
        }
    }

    // 1. The agent rolling-window ledger can never exceed the policy cap.
    function invariant_window_within_cap() public view {
        for (uint256 t = 0; t < 2; t++) {
            address token = t == 0 ? address(usdc) : address(0);
            (, uint256 dailyLimit) = vault.getPolicy(token);
            assertLe(vault.spentInWindow(token), dailyLimit, "rolling window exceeds cap");
        }
    }

    // 2. The contract's rolling window must EXACTLY match the ghost model
    //    of what actually left the vault through the agent paths.
    function invariant_window_matches_ghost_model() public view {
        for (uint256 t = 0; t < 2; t++) {
            address token = t == 0 ? address(usdc) : address(0);
            assertEq(
                vault.spentInWindow(token), _ghostWindow(token), "rolling window drifted from actual agent outflow"
            );
        }
    }

    // 3. Solvency: nothing created, nothing lost (agent + approved + swaps).
    //    vault balance == initial + swap buys - all outflows
    function invariant_solvency() public view {
        assertEq(
            usdc.balanceOf(address(vault)) + handler.ghostTotalOut(address(usdc)) - handler.ghostTotalIn(address(usdc)),
            INITIAL_USDC,
            "USDC solvency broken"
        );
        assertEq(
            address(vault).balance + handler.ghostTotalOut(address(0)) - handler.ghostTotalIn(address(0)),
            INITIAL_ETH,
            "ETH solvency broken"
        );
    }
}
