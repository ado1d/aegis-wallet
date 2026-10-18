// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC — USDC-like demo asset for local chains and testnets.
 * @notice 6 decimals like real USDC, with an open `mint` that behaves like a
 *         faucet so demos can fund wallets without a real faucet.
 *         NEVER use for anything of value — demo/test environments only.
 */
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin (Aegis Demo)", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @dev Open mint = faucet for local anvil + testnet demos.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
