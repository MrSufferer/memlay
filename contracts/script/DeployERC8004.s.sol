// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {ERC8004IdentityRegistry} from "../src/ERC8004IdentityRegistry.sol";
import {ERC8004ReputationRegistry} from "../src/ERC8004ReputationRegistry.sol";

/// @notice Deploys the two ERC-8004 registry contracts on the target chain.
/// @dev Usage:
///      forge script script/DeployERC8004.s.sol \
///        --rpc-url sepolia \
///        --private-key $DEPLOYER_KEY \
///        --broadcast \
///        --verify
///
///      Or with a .env file via cast:
///      cast rpc ethAccounts  # verify forge has the key
contract DeployERC8004 is Script {
    function run() external {
        // Supports CRE_ETH_PRIVATE_KEY (project convention) or raw DEPLOYER_KEY.
        uint256 deployerPrivateKey;
        string memory keyLabel;
        try vm.envUint("CRE_ETH_PRIVATE_KEY") returns (uint256 key) {
            deployerPrivateKey = key;
            keyLabel = "CRE_ETH_PRIVATE_KEY";
        } catch {
            deployerPrivateKey = vm.envUint("DEPLOYER_KEY");
            keyLabel = "DEPLOYER_KEY";
        }
        address deployer = vm.addr(deployerPrivateKey);

        console.log("[DeployERC8004] Deployer:", deployer);
        console.log("[DeployERC8004] Key used:", keyLabel);

        // Deploy Identity Registry first
        vm.startBroadcast(deployerPrivateKey);
        ERC8004IdentityRegistry identityRegistry = new ERC8004IdentityRegistry();
        console.log("[DeployERC8004] IdentityRegistry deployed at:", address(identityRegistry));

        // Deploy Reputation Registry
        ERC8004ReputationRegistry reputationRegistry = new ERC8004ReputationRegistry();
        console.log("[DeployERC8004] ReputationRegistry deployed at:", address(reputationRegistry));
        vm.stopBroadcast();

        // Print the values you need to set in your .env
        console.log("");
        console.log("=== Add these to your .env ===");
        console.log("ERC8004_IDENTITY_REGISTRY=");
        console.logAddress(address(identityRegistry));
        console.log("ERC8004_REPUTATION_REGISTRY=");
        console.logAddress(address(reputationRegistry));
        console.log("==============================");
    }
}
