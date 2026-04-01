// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ERC8004ReputationRegistry — ERC-8004 Reputation Registry
/// @notice Stores trust signals (reliability, uptime, etc.) for ERC-8004 agents.
///         Anyone can post feedback; there is no slashing logic — this contract
///         is an immutable, append-only log designed for on-chain consumers to
///         aggregate trust scores.
/// @dev This is a per-chain singleton; deploy once per chain.
contract ERC8004ReputationRegistry {
    /// @notice Emitted each time a feedback entry is recorded.
    /// @param agentId        The ERC-8004 agent tokenId.
    /// @param publisher      The EOA that published this feedback.
    /// @param value          The feedback value (signed int128, e.g. uptime * 100).
    /// @param valueDecimals  Number of decimal places encoded in value.
    /// @param tag1           Primary tag (e.g. "reachable", "uptime", "successRate", "responseTime").
    /// @param tag2           Secondary tag / endpoint slug (e.g. "scanner", "memory-writer").
    /// @param endpoint       Absolute URL of the endpoint being rated.
    /// @param feedbackURI    Optional URI pointing to richer off-chain feedback data.
    /// @param feedbackHash   KECCAK-256 hash of feedbackURI content for verifiability.
    event FeedbackRecorded(
        uint256 indexed agentId,
        address indexed publisher,
        int128 value,
        uint8 valueDecimals,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    /// @notice A single feedback entry stored on-chain.
    /// @param publisher       EOA that submitted the entry.
    /// @param value           The feedback value (signed int128).
    /// @param valueDecimals   Decimal places encoded in value.
    /// @param tag1            Primary tag.
    /// @param tag2            Secondary tag / endpoint slug.
    /// @param endpoint        Endpoint URL.
    /// @param feedbackURI     Off-chain URI (may be empty in v1).
    /// @param feedbackHash    KECCAK-256 hash of feedbackURI content.
    /// @param recordedAt      Block timestamp.
    struct FeedbackEntry {
        address publisher;
        int128  value;
        uint8   valueDecimals;
        string  tag1;
        string  tag2;
        string  endpoint;
        string  feedbackURI;
        bytes32 feedbackHash;
        uint256 recordedAt;
    }

    /// @notice Per-agent feedback log. agentId => FeedbackEntry[]
    mapping(uint256 => FeedbackEntry[]) public feedbackLog;

    /// @notice Record a new feedback entry for an agent.
    ///         Anyone can call this — no access control.
    /// @param agentId        The agent's tokenId in the Identity Registry.
    /// @param value          The feedback value (signed int128, e.g. 9987n for 99.87%).
    /// @param valueDecimals  Number of decimal places in value (e.g. 2 for percentages).
    /// @param tag1           Primary tag string (e.g. "reachable", "uptime").
    /// @param tag2           Secondary tag / endpoint slug.
    /// @param endpoint       Full URL of the endpoint being rated.
    /// @param feedbackURI    Optional URI to richer off-chain data (empty in v1).
    /// @param feedbackHash   KECCAK-256 hash of feedbackURI content (zero-hash in v1).
    function giveFeedback(
        uint256 agentId,
        int128  value,
        uint8   valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        require(bytes(tag1).length > 0, "ERC8004Reputation: empty tag1");
        require(bytes(tag2).length > 0, "ERC8004Reputation: empty tag2");
        require(bytes(endpoint).length > 0, "ERC8004Reputation: empty endpoint");

        FeedbackEntry[] storage entries = feedbackLog[agentId];
        entries.push();
        FeedbackEntry storage entry = entries[entries.length - 1];
        entry.publisher      = msg.sender;
        entry.value          = value;
        entry.valueDecimals  = valueDecimals;
        entry.tag1           = tag1;
        entry.tag2           = tag2;
        entry.endpoint       = endpoint;
        entry.feedbackURI    = feedbackURI;
        entry.feedbackHash   = feedbackHash;
        entry.recordedAt     = block.timestamp;

        emit FeedbackRecorded(
            agentId, msg.sender, value, valueDecimals,
            tag1, tag2, endpoint, feedbackURI, feedbackHash
        );
    }

    /// @notice Retrieve the full feedback history for an agent.
    /// @param agentId The agent's tokenId.
    /// @return Array of all FeedbackEntry structs recorded for this agent.
    function getFeedbackHistory(uint256 agentId) external view returns (FeedbackEntry[] memory) {
        return feedbackLog[agentId];
    }

    /// @notice Returns the count of feedback entries for an agent.
    /// @param agentId The agent's tokenId.
    /// @return Number of entries recorded.
    function getFeedbackCount(uint256 agentId) external view returns (uint256) {
        return feedbackLog[agentId].length;
    }
}
