// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Arena} from "../Arena.sol";

/// @notice Deploys Arena on X Layer testnet (chain ID 195) or mainnet (chain ID 196).
///
/// Usage:
///   # X Layer testnet
///   X_LAYER_RPC_URL=https://testrpc.xlayer.tech \
///   X_LAYER_PRIVATE_KEY=<your-key> \
///   forge script script/DeployArenaXLayer.s.sol \
///     --rpc-url xlayer_testnet \
///     --broadcast \
///     --verify
///
///   # X Layer mainnet
///   X_LAYER_RPC_URL=https://rpc.xlayer.tech \
///   X_LAYER_PRIVATE_KEY=<your-key> \
///   forge script script/DeployArenaXLayer.s.sol \
///     --rpc-url xlayer_mainnet \
///     --broadcast \
///     --verify
///
/// Prerequisites:
///   - X Layer testnet faucet funded wallet (https://www.okx.com/xlayer/faucet)
///   - Add X_LAYER_PRIVATE_KEY to .env
///   - registrationFee = 0 (hackathon MVP — no cost to register agents)
contract DeployArenaXLayer is Script {
    function run() external {
        // ── Load private key ───────────────────────────────────────────────────
        uint256 deployerPrivateKey;

        if (bytes(vm.envString("X_LAYER_PRIVATE_KEY")).length == 0) {
            revert(
                "[DeployArenaXLayer] X_LAYER_PRIVATE_KEY not set in .env.\n"
                "  Add: X_LAYER_PRIVATE_KEY=<your-64-char-hex-key>\n"
                "  Or:  X_LAYER_PRIVATE_KEY_FILE=/path/to/key.txt"
            );
        }

        // Support both raw hex and 0x-prefixed formats
        string memory rawKey = vm.envString("X_LAYER_PRIVATE_KEY");
        if (bytes(rawKey)[0] == bytes1("0")) {
            deployerPrivateKey = vm.envUint("X_LAYER_PRIVATE_KEY");
        } else {
            // Assume raw hex without 0x prefix
            string memory keyHex = string.concat("0x", rawKey);
            deployerPrivateKey = vm.envUint(keyHex);
        }

        address deployer = vm.addr(deployerPrivateKey);
        console.log("[DeployArenaXLayer] Deployer address:", deployer);
        console.log("[DeployArenaXLayer] Chain ID (via RPC): checking...");

        // ── Determine network from RPC ─────────────────────────────────────────
        // Forge will have set the chain ID via --rpc-url flag.
        // We read it from the VM's active chain.
        uint256 chainId = block.chainid;
        console.log("[DeployArenaXLayer] Chain ID:", chainId);

        bool isTestnet = (chainId == 195);
        bool isMainnet = (chainId == 196);

        if (!isTestnet && !isMainnet) {
            revert(
                string.concat(
                    "[DeployArenaXLayer] Unsupported chain ID: ",
                    vm.toString(chainId),
                    ". Expected 195 (testnet) or 196 (mainnet)."
                )
            );
        }

        console.log("[DeployArenaXLayer] Network: ", isTestnet ? "X Layer Testnet" : "X Layer Mainnet");

        // ── Check deployer balance ─────────────────────────────────────────────
        uint256 balance = deployer.balance;
        console.log("[DeployArenaXLayer] Deployer balance:", balance, "wei");

        if (balance == 0) {
            revert(
                "[DeployArenaXLayer] Deployer balance is 0.\n"
                "  Fund your wallet at: https://www.okx.com/xlayer/faucet\n"
                "  Then re-run this script."
            );
        }

        // ── Deploy Arena (registrationFee = 0 for hackathon) ─────────────────
        vm.startBroadcast(deployerPrivateKey);
        Arena arena = new Arena(/* registrationFee = */ 0);
        vm.stopBroadcast();

        console.log("");
        console.log("========================================");
        console.log("[DeployArenaXLayer] Arena deployed!");
        console.log("  Address:", address(arena));
        console.log("  Network: X Layer", isTestnet ? "Testnet (195)" : "Mainnet (196)");
        console.log("  Registration fee: 0 (hackathon MVP)");
        console.log("========================================");
        console.log("");
        console.log("=== Add to your .env ===");
        console.log(
            isTestnet
                ? "X_LAYER_ARENA_ADDRESS=testnet"
                : "X_LAYER_ARENA_ADDRESS=mainnet"
        );
        console.log(
            isTestnet
                ? string.concat("X_LAYER_ARENA_ADDRESS=", vm.toString(address(arena)))
                : string.concat("X_LAYER_ARENA_ADDRESS=", vm.toString(address(arena)))
        );
        console.log("=========================");
        console.log("");
        console.log("=== Explorer link ===");
        console.log(
            isTestnet
                ? string.concat("https://www.oklink.com/xlayer-test/address/", vm.toString(address(arena)))
                : string.concat("https://www.oklink.com/xlayer/address/", vm.toString(address(arena)))
        );

        // Emit a special log that the arena-client.ts reads to confirm deployment
        console.log("[DEPLOY_ARENA_ADDRESS]", vm.toString(address(arena)));
    }
}
