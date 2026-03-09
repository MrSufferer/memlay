// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {MemoryRegistry} from "../src/MemoryRegistry.sol";
import {MockKeystoneForwarder} from "../src/mocks/MockKeystoneForwarder.sol";

/// @title MemoryRegistryTest — Foundry unit tests for MemoryRegistry
/// @notice Tests all core functionality per the testing strategy doc:
///   - _processReport decoding
///   - MemoryCommitted event emission
///   - Forwarder access control
///   - Multi-agent isolation
///   - View function correctness
contract MemoryRegistryTest is Test {
    MemoryRegistry public registry;
    MockKeystoneForwarder public forwarder;

    address public deployer = address(this);
    address public unauthorizedCaller = address(0xBEEF);

    function setUp() public {
        forwarder = new MockKeystoneForwarder();
        registry = new MemoryRegistry(address(forwarder));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Helper: submit a report through the forwarder
    // ═══════════════════════════════════════════════════════════════════════

    function _submitReport(
        string memory agentId,
        string memory entryKey,
        bytes32 entryHash,
        uint256 timestamp
    ) internal {
        bytes memory report = abi.encode(agentId, entryKey, entryHash, timestamp);
        forwarder.report(address(registry), report);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Test: _processReport correctly decodes ABI data
    // ═══════════════════════════════════════════════════════════════════════

    function test_processReport_decodesCorrectly() public {
        string memory agentId = "agent-alpha-01";
        string memory entryKey = "lp-entry-2026-03-02";
        bytes32 entryHash = keccak256("test-entry-data");
        uint256 timestamp = 1709366400;

        _submitReport(agentId, entryKey, entryHash, timestamp);

        MemoryRegistry.Commitment memory commitment = registry.getCommitment(entryHash);
        assertEq(commitment.agentId, agentId);
        assertEq(commitment.entryKey, entryKey);
        assertEq(commitment.entryHash, entryHash);
        assertEq(commitment.committedAt, block.timestamp);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Test: MemoryCommitted event emitted with correct values
    // ═══════════════════════════════════════════════════════════════════════

    function test_processReport_emitsEvent() public {
        string memory agentId = "agent-alpha-01";
        string memory entryKey = "scan-result-001";
        bytes32 entryHash = keccak256("scan-data");

        // We check that the event is emitted (topic checks for indexed params)
        vm.expectEmit(false, false, false, true);
        emit MemoryRegistry.MemoryCommitted(agentId, entryHash, entryKey, block.timestamp);

        _submitReport(agentId, entryKey, entryHash, 1709366400);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Test: Rejects reports from non-forwarder addresses
    // ═══════════════════════════════════════════════════════════════════════

    function test_rejectsNonForwarder() public {
        bytes memory metadata = abi.encodePacked(
            bytes32(0),
            bytes10(0),
            address(0)
        );
        bytes memory report = abi.encode("agent", "key", bytes32(0), uint256(0));

        vm.prank(unauthorizedCaller);
        vm.expectRevert();
        registry.onReport(metadata, report);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Test: Stores multiple agent commitments independently
    // ═══════════════════════════════════════════════════════════════════════

    function test_multipleCommitmentsPerAgent() public {
        string memory agentId = "agent-alpha-01";

        bytes32 hash1 = keccak256("entry-1");
        bytes32 hash2 = keccak256("entry-2");
        bytes32 hash3 = keccak256("entry-3");

        _submitReport(agentId, "entry-1", hash1, 1000);
        _submitReport(agentId, "entry-2", hash2, 2000);
        _submitReport(agentId, "entry-3", hash3, 3000);

        assertEq(registry.getAgentHashCount(agentId), 3);
        assertEq(registry.getAgentHash(agentId, 0), hash1);
        assertEq(registry.getAgentHash(agentId, 1), hash2);
        assertEq(registry.getAgentHash(agentId, 2), hash3);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Test: getCommitment returns correct struct
    // ═══════════════════════════════════════════════════════════════════════

    function test_getCommitment() public {
        bytes32 entryHash = keccak256("commitment-test");
        _submitReport("agent-01", "key-01", entryHash, 5000);

        MemoryRegistry.Commitment memory c = registry.getCommitment(entryHash);
        assertEq(c.agentId, "agent-01");
        assertEq(c.entryKey, "key-01");
        assertEq(c.entryHash, entryHash);
        assertTrue(c.committedAt > 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Test: getCommitment returns zeroed struct for unknown hash
    // ═══════════════════════════════════════════════════════════════════════

    function test_getCommitment_unknownHash() public view {
        bytes32 unknownHash = keccak256("does-not-exist");
        MemoryRegistry.Commitment memory c = registry.getCommitment(unknownHash);
        assertEq(c.entryHash, bytes32(0));
        assertEq(c.committedAt, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Test: getAgentHashCount returns correct count
    // ═══════════════════════════════════════════════════════════════════════

    function test_getAgentHashCount() public {
        assertEq(registry.getAgentHashCount("empty-agent"), 0);

        _submitReport("counter-agent", "k1", keccak256("h1"), 1);
        assertEq(registry.getAgentHashCount("counter-agent"), 1);

        _submitReport("counter-agent", "k2", keccak256("h2"), 2);
        assertEq(registry.getAgentHashCount("counter-agent"), 2);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Test: Multiple agents store independently (no collision)
    // ═══════════════════════════════════════════════════════════════════════

    function test_multipleAgentsIndependent() public {
        bytes32 hashA = keccak256("agent-a-entry");
        bytes32 hashB = keccak256("agent-b-entry");

        _submitReport("agent-a", "key-a", hashA, 100);
        _submitReport("agent-b", "key-b", hashB, 200);

        // Each agent has exactly 1 commitment
        assertEq(registry.getAgentHashCount("agent-a"), 1);
        assertEq(registry.getAgentHashCount("agent-b"), 1);

        // Hashes are stored correctly per agent
        assertEq(registry.getAgentHash("agent-a", 0), hashA);
        assertEq(registry.getAgentHash("agent-b", 0), hashB);

        // Commitment lookup works for both
        assertEq(registry.getCommitment(hashA).agentId, "agent-a");
        assertEq(registry.getCommitment(hashB).agentId, "agent-b");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Test: getAgentHash reverts on out-of-bounds index
    // ═══════════════════════════════════════════════════════════════════════

    function test_getAgentHash_outOfBounds() public {
        _submitReport("bounded-agent", "k1", keccak256("h1"), 1);

        vm.expectRevert();
        registry.getAgentHash("bounded-agent", 1); // Only index 0 exists
    }
}
