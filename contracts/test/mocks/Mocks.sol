// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @dev Test-only misbehaving contracts:
 *      - `BadToken` mimics non-standard ERC-20s (returns false / reverts on
 *        transfer). Used to prove the vault's state rolls back cleanly when
 *        an outbound transfer fails.
 *      - `RejectingEther` refuses native ETH, used to trigger
 *        `Aegis__EthTransferFailed`.
 */
contract BadToken {
    mapping(address => uint256) public balances;
    bool public revertMode;

    constructor(bool revertMode_) {
        revertMode = revertMode_;
    }

    function setBalance(address who, uint256 amount) external {
        balances[who] = amount;
    }

    function balanceOf(address who) external view returns (uint256) {
        return balances[who];
    }

    function transfer(address, uint256) external returns (bool) {
        if (revertMode) revert("BadToken: transfer reverts");
        return false;
    }

    function transferFrom(address, address, uint256) external returns (bool) {
        if (revertMode) revert("BadToken: transferFrom reverts");
        return false;
    }
}

/// @dev Receives nothing — every native transfer to it fails.
contract RejectingEther {
    receive() external payable {
        revert("RejectingEther: no ETH accepted");
    }

    fallback() external payable {
        revert("RejectingEther: no ETH accepted");
    }
}
