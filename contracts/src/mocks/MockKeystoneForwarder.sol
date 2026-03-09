// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IReceiver} from "../../interfaces/IReceiver.sol";

/// @title MockKeystoneForwarder — Test helper that bypasses DON signature validation
/// @notice Only for use in Foundry tests and local simulation.
///         Allows calling onReport directly without DON-signed metadata.
contract MockKeystoneForwarder {
    /// @notice Forward a report to a receiver contract, mimicking the KeystoneForwarder
    /// @param receiver The contract to forward the report to
    /// @param reportData The report data to forward
    function report(address receiver, bytes calldata reportData) external {
        // Build minimal metadata: 32 bytes workflowId + 10 bytes workflowName + 20 bytes workflowOwner
        bytes memory metadata = abi.encodePacked(
            bytes32(0),  // workflowId (unused in tests)
            bytes10(0),  // workflowName (unused in tests)
            address(this) // workflowOwner = this contract
        );

        IReceiver(receiver).onReport(metadata, reportData);
    }
}
