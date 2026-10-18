// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title MockSwap — fixed-rate swap venue for the Aegis demo (CP1.1).
 *
 * @notice Models an exchange counterparty with a deterministic price:
 *         `outAmount = sellAmount * rateNum / rateDen` per token pair,
 *         set by the venue owner (no oracle, no MEV, fully reproducible for
 *         demos and evidence harvesting).
 *
 *         Safety properties the vault relies on:
 *           - Rates are owner-set; an unset pair reverts (fail closed).
 *           - The venue NEVER chooses the recipient: buy assets are paid to
 *             `msg.sender` (the vault), so the agent cannot route funds to
 *             arbitrary addresses through swaps.
 *           - `minOut` is enforced BY the venue (reverts below the floor);
 *             the vault re-checks the returned amount as defence in depth.
 *
 *         The venue must hold inventory of every buy asset it pays out:
 *         fund it from the owner key (ERC-20 `transfer`, or plain ETH send).
 *
 * @dev NEVER use for anything of value — demo/test environments only.
 */
contract MockSwap {
    using SafeERC20 for IERC20;

    address public immutable owner;
    address public constant NATIVE = address(0);

    /// @notice sellToken => buyToken => {num, den}; out = sell * num / den.
    mapping(address => mapping(address => uint256[2])) public rate;

    error MockSwap__NotOwner(address caller);
    error MockSwap__RateNotSet(address sellToken, address buyToken);
    error MockSwap__BelowMinOut(uint256 outAmount, uint256 minOut);
    error MockSwap__BadMsgValue(uint256 got, uint256 want);
    error MockSwap__EthPayoutFailed();

    event RateSet(address indexed sellToken, address indexed buyToken, uint256 num, uint256 den);
    event Swapped(
        address indexed seller,
        address indexed sellToken,
        address indexed buyToken,
        uint256 sellAmount,
        uint256 outAmount,
        uint256 minOut
    );

    constructor() {
        owner = msg.sender;
    }

    /// @notice Set the fixed rate for a pair, as a fraction (num/den).
    ///         Example — sell USDC (6 dec) for ETH at $4,000/ETH:
    ///         setRate(usdc, NATIVE, 1 ether, 4_000e6)
    ///         => 200 USDC pays out 0.05 ETH.
    function setRate(address sellToken, address buyToken, uint256 num, uint256 den) external {
        if (msg.sender != owner) revert MockSwap__NotOwner(msg.sender);
        if (sellToken == buyToken || den == 0 || num == 0) revert MockSwap__RateNotSet(sellToken, buyToken);
        rate[sellToken][buyToken] = [num, den];
        emit RateSet(sellToken, buyToken, num, den);
    }

    /// @notice Quote helper (dashboard + agent slippage math).
    function quote(address sellToken, address buyToken, uint256 sellAmount) external view returns (uint256 outAmount) {
        uint256[2] memory r = rate[sellToken][buyToken];
        if (r[1] == 0) revert MockSwap__RateNotSet(sellToken, buyToken);
        return Math.mulDiv(sellAmount, r[0], r[1]);
    }

    /**
     * @notice Execute a fixed-rate swap. Called by the vault (`agentSwap`)
     *         or directly by the owner for manual testing.
     *         ERC-20 sell side: the vault pre-approved the venue, funds are
     *         pulled here. Native sell side: the ETH arrives as `msg.value`.
     *         The buy asset is ALWAYS paid to `msg.sender`.
     */
    function swap(address sellToken, address buyToken, uint256 sellAmount, uint256 minOut)
        external
        payable
        returns (uint256 outAmount)
    {
        uint256[2] memory r = rate[sellToken][buyToken];
        if (r[1] == 0) revert MockSwap__RateNotSet(sellToken, buyToken);

        uint256 wantValue = sellToken == NATIVE ? sellAmount : 0;
        if (msg.value != wantValue) revert MockSwap__BadMsgValue(msg.value, wantValue);

        outAmount = Math.mulDiv(sellAmount, r[0], r[1]);
        if (outAmount < minOut) revert MockSwap__BelowMinOut(outAmount, minOut);

        if (sellToken != NATIVE) {
            IERC20(sellToken).safeTransferFrom(msg.sender, address(this), sellAmount);
        }
        if (buyToken == NATIVE) {
            (bool ok,) = msg.sender.call{value: outAmount}("");
            if (!ok) revert MockSwap__EthPayoutFailed();
        } else {
            IERC20(buyToken).safeTransfer(msg.sender, outAmount);
        }

        emit Swapped(msg.sender, sellToken, buyToken, sellAmount, outAmount, minOut);
    }

    receive() external payable {} // accept ETH inventory funding
}
