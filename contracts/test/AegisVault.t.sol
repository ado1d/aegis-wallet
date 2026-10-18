// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {AegisVault} from "../src/AegisVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {BadToken} from "./mocks/Mocks.sol";

/**
 * @dev Core unit tests: deployment, configuration, access control,
 *      whitelist bookkeeping, deposits and the sovereign owner path.
 */
contract AegisVaultCoreTest is BaseTest {
    // ------------------------------------------------------------- deploy

    function test_deployment_state() public view {
        assertEq(vault.owner(), owner, "owner");
        assertEq(vault.agent(), agent, "agent");
        assertEq(uint8(vault.agentStatus()), uint8(AegisVault.AgentStatus.Active), "agent Active");
    }

    function test_deploy_without_agent() public {
        vm.prank(owner);
        AegisVault bare = new AegisVault(address(0));
        assertEq(bare.agent(), address(0));
        assertEq(uint8(bare.agentStatus()), uint8(AegisVault.AgentStatus.None));
        // nobody can act as agent
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__NotAgent.selector, stranger));
        bare.agentExecute(address(usdc), savings, 1, "no agent configured");
    }

    // ------------------------------------------------------------- policy

    function test_setTokenPolicy_stores_and_emits() public {
        vm.expectEmit();
        emit AegisVault.TokenPolicyUpdated(address(usdc), CAP_PER_TX, 500e6, DAILY, 900e6);
        vm.prank(owner);
        vault.setTokenPolicy(address(usdc), 500e6, 900e6);

        (uint256 maxPerTx, uint256 dailyLimit) = vault.getPolicy(address(usdc));
        assertEq(maxPerTx, 500e6);
        assertEq(dailyLimit, 900e6);
    }

    function test_setTokenPolicy_only_owner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__NotOwner.selector, stranger));
        vault.setTokenPolicy(address(usdc), 1, 1);
    }

    function test_zero_policy_disables_auto_but_keeps_queue() public {
        vm.startPrank(owner);
        vault.setTokenPolicy(address(usdc), 0, 0);
        vm.stopPrank();

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__ExceedsPerTxLimit.selector, address(usdc), 1e6, 0));
        vault.agentExecute(address(usdc), savings, 1e6, "auto disabled");

        // queue path still available
        vm.prank(agent);
        vault.submitForApproval(address(usdc), savings, 1e6, 10, "needs a human now");
        assertEq(vault.queueLength(), 1);
    }

    // ---------------------------------------------------------- whitelist

    function test_whitelist_add_enumerates() public {
        address a = makeAddr("a");
        vm.prank(owner);
        vault.setWhitelist(a, "A", true);

        assertTrue(vault.whitelisted(a));
        assertEq(vault.whitelistCount(), 3);
        assertEq(vault.getWhitelist().length, 3);
        assertEq(vault.whitelistLabel(a), "A");
    }

    function test_whitelist_remove_middle_swap_pop() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        vm.startPrank(owner);
        vault.setWhitelist(a, "A", true);
        vault.setWhitelist(b, "B", true);
        vm.stopPrank();
        // list is now [savings, supplier, a, b]; remove `a` (middle)
        vm.prank(owner);
        vault.setWhitelist(a, "", false);

        assertFalse(vault.whitelisted(a));
        address[] memory list = vault.getWhitelist();
        assertEq(list.length, 3);
        assertEq(list[2], b); // b swapped into a's slot

        // re-adding works and appends
        vm.prank(owner);
        vault.setWhitelist(a, "A2", true);
        assertEq(vault.whitelistCount(), 4);
        assertTrue(vault.whitelisted(a));
    }

    function test_whitelist_remove_last_element() public {
        vm.prank(owner);
        vault.setWhitelist(supplier, "", false); // supplier is last of [savings, supplier]
        assertFalse(vault.whitelisted(supplier));
        assertEq(vault.whitelistCount(), 1);
        assertEq(vault.getWhitelist()[0], savings);
    }

    function test_whitelist_zero_address_reverts() public {
        vm.prank(owner);
        vm.expectRevert(AegisVault.Aegis__InvalidRecipient.selector);
        vault.setWhitelist(address(0), "nope", true);
    }

    function test_whitelist_only_owner() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__NotOwner.selector, agent));
        vault.setWhitelist(unknown, "x", true);
    }

    // ----------------------------------------------------------- deposits

    function test_deposit_native_both_paths() public {
        vm.deal(stranger, 2 ether);
        vm.startPrank(stranger);

        vm.expectEmit();
        emit AegisVault.Deposited(address(0), stranger, 1 ether);
        vault.deposit{value: 1 ether}();

        (bool ok,) = address(vault).call{value: 1 ether}(""); // plain send -> receive()
        assertTrue(ok);
        vm.stopPrank();

        assertEq(address(vault).balance, VAULT_ETH + 2 ether);
    }

    function test_deposit_zero_value_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(AegisVault.Aegis__InvalidAmount.selector);
        vault.deposit{value: 0}();
    }

    function test_depositERC20_pulls_funds() public {
        usdc.mint(stranger, 100e6);
        vm.startPrank(stranger);
        usdc.approve(address(vault), 100e6);
        vault.depositERC20(address(usdc), 100e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(vault)), VAULT_FUNDS + 100e6);
    }

    function test_depositERC20_bad_token_reverts() public {
        BadToken bad = new BadToken(false); // returns false on transferFrom
        vm.startPrank(stranger);
        vm.expectRevert();
        vault.depositERC20(address(bad), 1);
        vm.stopPrank();
    }

    // ------------------------------------------------- sovereign owner

    function test_ownerWithdraw_is_sovereign() public {
        // non-whitelisted recipient, amount above every agent cap — allowed by design
        vm.expectEmit();
        emit AegisVault.OwnerWithdrawal(address(usdc), unknown, 9_000e6);
        vm.prank(owner);
        vault.ownerWithdraw(address(usdc), unknown, 9_000e6);
        assertEq(usdc.balanceOf(unknown), 9_000e6);
    }

    function test_ownerWithdraw_native() public {
        vm.deal(address(vault), 3 ether);
        vm.prank(owner);
        vault.ownerWithdraw(address(0), unknown, 3 ether);
        assertEq(unknown.balance, 3 ether);
    }

    function test_ownerWithdraw_insufficient_balance() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                AegisVault.Aegis__InsufficientBalance.selector, address(usdc), VAULT_FUNDS, VAULT_FUNDS + 1
            )
        );
        vault.ownerWithdraw(address(usdc), unknown, VAULT_FUNDS + 1);
    }

    function test_ownerWithdraw_only_owner() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__NotOwner.selector, agent));
        vault.ownerWithdraw(address(usdc), unknown, 1);
    }

    // -------------------------------------------------------------- views

    function test_getTx_invalid_ids() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__InvalidTxId.selector, 0));
        vault.getTx(0);

        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__InvalidTxId.selector, 1));
        vault.getTx(1); // queue empty, next id = 1
    }

    function test_window_constants() public view {
        // CP1.1: a spend counts against the cap for exactly 24 hours.
        assertEq(vault.WINDOW(), 24 hours);
        assertEq(vault.WINDOW_CAPACITY(), 64);
    }

    // ------------------------------------------------- access control map

    function test_agent_cannot_call_owner_functions() public {
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__NotOwner.selector, agent));
        vault.setTokenPolicy(address(usdc), 1, 1);

        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__NotOwner.selector, agent));
        vault.approveTx(1);

        vm.expectRevert(abi.encodeWithSelector(AegisVault.Aegis__NotOwner.selector, agent));
        vault.pauseAgent();
        vm.stopPrank();
    }
}
