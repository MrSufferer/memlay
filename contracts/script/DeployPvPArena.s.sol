// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {PvPArena} from "../src/PvPArena.sol";

/// @notice Deploys PvPArena on Base (or Base Sepolia testnet).
/// @dev Usage:
///      # Base Sepolia (testnet)
///      forge script script/DeployPvPArena.s.sol \
///        --rpc-url base_sepolia \
///        --private-key $DEPLOYER_KEY \
///        --broadcast \
///        --verify
///
///      # Base Mainnet
///      BASE_RPC_URL=https://mainnet.base.org forge script script/DeployPvPArena.s.sol \
///        --rpc-url base_mainnet \
///        --private-key $DEPLOYER_KEY \
///        --broadcast \
///        --verify
///
/// Prerequisites:
///   - ERC-8004 IdentityRegistry must already be deployed on the same chain.
///   - Set IDENTITY_REGISTRY_ADDRESS in .env or as vm.envAddress.
contract DeployPvPArena is Script {
    function run() external {
        uint256 deployerPrivateKey;
        string memory keyLabel;

        try vm.envUint("CRE_ETH_PRIVATE_KEY") returns (uint256 key) {
            deployerPrivateKey = key;
            keyLabel = "CRE_ETH_PRIVATE_KEY";
        } catch {
            deployerPrivateKey = vm.envUint("DEPLOYER_KEY");
            keyLabel = "DEPLOYER_KEY";
        }

        // Identity registry — must be deployed first on the same chain
        address identityRegistry;
        try vm.envAddress("IDENTITY_REGISTRY_ADDRESS") returns (address addr) {
            identityRegistry = addr;
        } catch {
            revert("[DeployPvPArena] IDENTITY_REGISTRY_ADDRESS not set in .env");
        }

        address deployer = vm.addr(deployerPrivateKey);
        console.log("[DeployPvPArena] Deployer:", deployer);
        console.log("[DeployPvPArena] Key used:", keyLabel);
        console.log("[DeployPvPArena] Identity Registry:", identityRegistry);

        vm.startBroadcast(deployerPrivateKey);
        PvPArena arena = new PvPArena(identityRegistry);
        console.log("[DeployPvPArena] PvPArena deployed at:", address(arena));
        vm.stopBroadcast();

        console.log("");
        console.log("=== Add these to your .env ===");
        console.log("PVP_ARENA_ADDRESS=");
        console.logAddress(address(arena));
        console.log("==============================");
    }
}
