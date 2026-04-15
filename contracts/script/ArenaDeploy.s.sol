// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {Arena} from "../Arena.sol";

/// @notice Deploy Arena.sol to X Layer testnet (chain ID 195).
/// Usage:
///   forge script script/ArenaDeploy.s.sol \
///     --rpc-url xlayer_testnet \
///     --private-key $X_LAYER_PRIVATE_KEY \
///     --broadcast \
///     -vvv
///
/// The contract is deployed with registrationFee = 0 (free for hackathon).
contract ArenaDeploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("X_LAYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deploying Arena to X Layer testnet...");
        console.log("Deployer:", deployer);
        console.log("Chain ID:", block.chainid);

        vm.startBroadcast(deployerPrivateKey);

        // registrationFee = 0 (free hackathon registration)
        Arena arena = new Arena(0);

        vm.stopBroadcast();

        console.log("Arena deployed at:", address(arena));
        console.log("");
        console.log("=== Deployment Complete ===");
        console.log("X_LAYER_ARENA_ADDRESS=", address(arena));
        console.log("Add the above to your .env as X_LAYER_ARENA_ADDRESS");
    }
}
