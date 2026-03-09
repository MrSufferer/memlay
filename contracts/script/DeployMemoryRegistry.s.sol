// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {MemoryRegistry} from "../src/MemoryRegistry.sol";

/// @title DeployMemoryRegistry — Foundry deployment script
/// @notice Deploys MemoryRegistry with the specified forwarder address.
///
/// Usage (Sepolia):
///   forge script script/DeployMemoryRegistry.s.sol \
///     --rpc-url $RPC_URL \
///     --broadcast \
///     --private-key $PRIVATE_KEY \
///     -vvvv
///
/// For simulation (no broadcast):
///   forge script script/DeployMemoryRegistry.s.sol --rpc-url $RPC_URL -vvvv
contract DeployMemoryRegistry is Script {
    /// @dev Sepolia KeystoneForwarder address.
    ///      For local testing, deploy MockKeystoneForwarder first and use that address.
    address constant SEPOLIA_FORWARDER = 0x447Fd5eC2D383091C22B8549cb231a3bAD6d3fAf;

    function run() external {
        // Use FORWARDER_ADDRESS env var if set, otherwise default to Sepolia forwarder
        address forwarder = vm.envOr("FORWARDER_ADDRESS", SEPOLIA_FORWARDER);

        console.log("Deploying MemoryRegistry...");
        console.log("  Forwarder:", forwarder);

        vm.startBroadcast();

        MemoryRegistry registry = new MemoryRegistry(forwarder);

        vm.stopBroadcast();

        console.log("MemoryRegistry deployed at:", address(registry));
        console.log("  Owner:", registry.owner());
    }
}
