// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReceiverTemplate} from "../interfaces/ReceiverTemplate.sol";

/// @title MemoryRegistry — On-chain episodic memory anchor for MemoryVault Agent Protocol
/// @notice Stores hash commitments of encrypted agent decision entries.
///         Each entry is AES-GCM encrypted in S3; only the hash is stored on-chain
///         via DON-signed writeReport calls through the KeystoneForwarder.
/// @dev Inherits ReceiverTemplate which handles forwarder validation and ERC165.
///      Uses a MockKeystoneForwarder for simulation, real KeystoneForwarder for Sepolia.
contract MemoryRegistry is ReceiverTemplate {
    /// @notice Represents a single hash commitment for an agent's decision entry
    struct Commitment {
        string  agentId;      // Agent that committed this entry
        string  entryKey;     // Unique key (e.g., "lp-entry-2026-03-02T10:14:05Z")
        bytes32 entryHash;    // SHA-256 hash of the plaintext entry data
        uint256 committedAt;  // Block timestamp when committed
    }

    /// @notice Lookup: entryHash => Commitment
    mapping(bytes32 => Commitment) public commitments;

    /// @notice All hashes for a given agent (chronological order)
    mapping(string => bytes32[]) public agentHashes;

    /// @notice Emitted when a new memory entry is committed
    /// @param agentId The agent that committed the entry
    /// @param entryHash SHA-256 hash of the plaintext entry data
    /// @param entryKey Unique key identifying this entry
    /// @param timestamp Block timestamp when committed
    event MemoryCommitted(
        string indexed agentId,
        bytes32 entryHash,
        string entryKey,
        uint256 timestamp
    );

    /// @notice Constructor — sets the forwarder address for report validation
    /// @param forwarderAddress The KeystoneForwarder (or MockKeystoneForwarder) address
    constructor(address forwarderAddress) ReceiverTemplate(forwarderAddress) {}

    /// @notice Processes a DON-signed report containing a memory commitment
    /// @dev Called by ReceiverTemplate.onReport() after forwarder validation
    /// @param report ABI-encoded (string agentId, string entryKey, bytes32 entryHash, uint256 timestamp)
    function _processReport(bytes calldata report) internal override {
        (
            string memory agentId,
            string memory entryKey,
            bytes32 entryHash,
            // timestamp from report is decoded but unused — we use block.timestamp
        ) = abi.decode(report, (string, string, bytes32, uint256));

        commitments[entryHash] = Commitment(
            agentId,
            entryKey,
            entryHash,
            block.timestamp
        );
        agentHashes[agentId].push(entryHash);

        emit MemoryCommitted(agentId, entryHash, entryKey, block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // View Functions (used by audit-reader and integrity-checker workflows)
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Get the full commitment for a given hash
    /// @param hash The entry hash to look up
    /// @return The Commitment struct (zeroed if not found)
    function getCommitment(bytes32 hash) external view returns (Commitment memory) {
        return commitments[hash];
    }

    /// @notice Get the total number of commitments for an agent
    /// @param agentId The agent identifier
    /// @return The number of hash commitments
    function getAgentHashCount(string calldata agentId) external view returns (uint256) {
        return agentHashes[agentId].length;
    }

    /// @notice Get a specific hash by index for an agent
    /// @param agentId The agent identifier
    /// @param index The index in the agent's hash array
    /// @return The entry hash at the given index
    function getAgentHash(string calldata agentId, uint256 index) external view returns (bytes32) {
        return agentHashes[agentId][index];
    }
}
