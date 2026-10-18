// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AegisVault} from "../src/AegisVault.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockSwap} from "../src/mocks/MockSwap.sol";

/**
 * @notice Real deployment script (Sepolia / Polygon Amoy / any EVM chain).
 *
 * Required env (see .env.example):
 *   OWNER_KEY    — private key of the human owner (deployer). Keep this safe.
 *   AGENT_KEY    — optional; the AI executor's key. You can also set it later
 *                  via `setAgent` once the backend (Checkpoint 2) has its key.
 *   USDC_ADDRESS — optional; use an existing asset. If unset, a MockUSDC is
 *                  deployed and 10,000 demo USDC is minted to the owner.
 *   ETH_PRICE    — optional; USD price of ETH used for the MockSwap fixed
 *                  rate (default 4000 => $4,000 / ETH). Only used when the
 *                  MockSwap venue is deployed (i.e. USDC_ADDRESS unset or
 *                  MOCK_SWAP=1).
 *
 * Deploys:
 *   1. MockUSDC (unless USDC_ADDRESS is given)   — demo asset w/ faucet mint
 *   2. MockSwap venue (CP1.1)                    — fixed-rate swap counterparty
 *   3. AegisVault                                — the guarded vault itself
 * and wires them: vault.setSwapVenue(venue), USDC->ETH rate, initial policy
 * (1,000 USDC per tx / 1,500 USDC per rolling 24h — sane demo defaults you
 * can change later with setTokenPolicy).
 *
 * Usage:
 *   forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast
 */
contract DeployAegis is Script {
    function run() external {
        uint256 ownerKey = vm.envUint("OWNER_KEY");
        address owner = vm.addr(ownerKey);
        uint256 agentKey = vm.envOr("AGENT_KEY", uint256(0));
        address envAsset = vm.envOr("USDC_ADDRESS", address(0));
        uint256 ethPrice = vm.envOr("ETH_PRICE", uint256(4000)); // USD per ETH

        vm.startBroadcast(ownerKey);

        // ---------------- 1. demo asset ----------------
        address asset;
        if (envAsset == address(0)) {
            MockUSDC usdc = new MockUSDC();
            usdc.mint(owner, 10_000e6); // demo faucet (mock only)
            asset = address(usdc);
            console2.log("[deploy] MockUSDC deployed, 10,000 demo USDC minted to owner:", asset);
        } else {
            asset = envAsset;
            console2.log("[deploy] Using existing asset:", asset);
        }

        // ---------------- 2. swap venue (CP1.1) ----------------
        MockSwap venue = new MockSwap();
        // fixed rate: sell USDC (6 dec) -> ETH at $ETH_PRICE per ETH
        //   out(wei) = usdcAmount * 1e18 / (price * 1e6)
        venue.setRate(asset, address(0), 1 ether, ethPrice * 1e6);
        // fund the venue with ETH inventory so USDC->ETH swaps pay out
        // (2 demo swaps of 200+150 USDC at $4k/ETH need 0.0875 ETH)
        uint256 venueSeed = 0.1 ether;
        if (address(owner).balance > venueSeed + 0.01 ether) {
            payable(address(venue)).transfer(venueSeed);
        } else {
            console2.log("[deploy] WARNING: owner balance too low to seed the venue with 0.1 ETH.");
            console2.log("[deploy]          USDC->ETH swaps will revert until you top it up:");
            console2.log("[deploy]          cast send <VENUE> --value 0.1ether --private-key $OWNER_KEY --rpc-url $RPC");
        }
        console2.log("[deploy] MockSwap venue (CP1.1):", address(venue));
        console2.log("[deploy] MockSwap fixed rate, USD per ETH:", ethPrice);

        // ---------------- 3. the vault ----------------
        address agent = agentKey == 0 ? address(0) : vm.addr(agentKey);
        AegisVault vault = new AegisVault(agent);
        vault.setSwapVenue(address(venue));

        // sane demo defaults — adjust anytime via setTokenPolicy / setWhitelist
        vault.setTokenPolicy(asset, 1000e6, 1500e6); // 1,000/tx, 1,500 per rolling 24h
        vault.setTokenPolicy(address(0), 0.05 ether, 0.1 ether); // ETH sell-side for swaps

        console2.log("[deploy] AegisVault:", address(vault));
        console2.log("[deploy] owner    :", owner);
        if (agent != address(0)) console2.log("[deploy] agent    :", agent);
        console2.log("[deploy] asset    :", asset);
        console2.log("[deploy] venue    :", address(venue));
        console2.log("[deploy] USDC policy: 1,000 per tx / 1,500 per rolling 24h");
        console2.log("[deploy] Next: fund + whitelist (see INSTRUCTIONS.md 'Manual' section).");

        vm.stopBroadcast();
    }
}
