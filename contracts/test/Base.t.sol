// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AegisVault} from "../src/AegisVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockSwap} from "../src/mocks/MockSwap.sol";

/**
 * @dev Shared fixture for all AegisVault tests.
 *      Mirrors the demo scenario: a funded vault with two whitelisted
 *      recipients, a USDC policy of 1,000 per tx / 1,500 per rolling 24h,
 *      and a funded MockSwap venue at a fixed $4,000 / ETH rate.
 */
abstract contract BaseTest is Test {
    AegisVault vault;
    MockUSDC usdc;
    MockSwap venue;

    address owner;
    address agent;
    address savings; // Story 1 recipient
    address supplier; // Story 2 recipient
    address stranger; // neither owner nor agent
    address unknown; // never whitelisted (Story 4 attacker)

    uint256 constant CAP_PER_TX = 1000e6;
    uint256 constant DAILY = 1500e6;
    uint256 constant VAULT_FUNDS = 10_000e6;
    uint256 constant VAULT_ETH = 50 ether;

    /// @dev $4,000 / ETH: 1 USDC (6 dec) buys 1e18/4000e6 wei.
    uint256 constant RATE_USDC_TO_ETH_NUM = 1 ether;
    uint256 constant RATE_USDC_TO_ETH_DEN = 4_000e6;

    function setUp() public virtual {
        owner = makeAddr("owner");
        agent = makeAddr("agent");
        savings = makeAddr("savings");
        supplier = makeAddr("supplier");
        stranger = makeAddr("stranger");
        unknown = makeAddr("unknown");

        vm.deal(owner, VAULT_ETH + 1 ether); // fund owner BEFORE the prank

        vm.startPrank(owner);
        usdc = new MockUSDC();
        venue = new MockSwap();
        vault = new AegisVault(agent);
        vault.setWhitelist(savings, "Savings Wallet", true);
        vault.setWhitelist(supplier, "Acme Design Ltd (supplier)", true);
        vault.setTokenPolicy(address(usdc), CAP_PER_TX, DAILY);
        vault.setTokenPolicy(address(0), 1 ether, 2 ether);
        usdc.mint(owner, VAULT_FUNDS);
        usdc.approve(address(vault), type(uint256).max);
        vault.depositERC20(address(usdc), VAULT_FUNDS);
        vault.deposit{value: VAULT_ETH}();
        vault.setSwapVenue(address(venue));
        vm.stopPrank();

        // venue inventory: ETH to pay out on USDC->ETH swaps (cheatcode top-up)
        vm.deal(address(venue), 500 ether);

        // fixed rate: 200 USDC -> 0.05 ETH (i.e. $4,000 / ETH)
        vm.prank(owner);
        venue.setRate(address(usdc), address(0), RATE_USDC_TO_ETH_NUM, RATE_USDC_TO_ETH_DEN);
    }

    /// @dev Agent auto-executes a USDC transfer.
    function _execute(address to, uint256 amount, string memory reason) internal {
        vm.prank(agent);
        vault.agentExecute(address(usdc), to, amount, reason);
    }

    /// @dev Expected ETH payout for a USDC->ETH swap at the fixture rate.
    function _ethOut(uint256 usdcAmount) internal pure returns (uint256) {
        return (usdcAmount * RATE_USDC_TO_ETH_NUM) / RATE_USDC_TO_ETH_DEN;
    }
}
