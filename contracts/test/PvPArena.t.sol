// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {PvPArena} from "../src/PvPArena.sol";
import {ERC8004IdentityRegistry} from "../src/ERC8004IdentityRegistry.sol";

contract PvPArenaTest is Test {
    PvPArena public arena;
    ERC8004IdentityRegistry public identityRegistry;

    address public alice = makeAddr("alice");
    address public bob = makeAddr("bob");

    uint256 public aliceAgentId;
    uint256 public bobAgentId;

    function setUp() public {
        // Deploy ERC-8004 Identity Registry
        identityRegistry = new ERC8004IdentityRegistry();

        // Register two agents via ERC-8004
        vm.prank(alice);
        aliceAgentId = identityRegistry.register("ipfs://alice-metadata.json");

        vm.prank(bob);
        bobAgentId = identityRegistry.register("ipfs://bob-metadata.json");

        // Deploy PvPArena pointing to the identity registry
        arena = new PvPArena(address(identityRegistry));
    }

    function test_registerAgent() public {
        // Both agents can register in the arena
        vm.prank(alice);
        arena.registerAgent(aliceAgentId, alice);

        vm.prank(bob);
        arena.registerAgent(bobAgentId, bob);

        PvPArena.ArenaAgent memory ag = arena.getAgent(aliceAgentId);
        assertEq(ag.wallet, alice);
        assertTrue(ag.isActive);
        assertEq(ag.wins, 0);
        assertEq(ag.tradeCount, 0);
        assertEq(ag.erc8004TokenId, aliceAgentId);
    }

    function test_createDuel() public {
        vm.prank(alice);
        arena.registerAgent(aliceAgentId, alice);
        vm.prank(bob);
        arena.registerAgent(bobAgentId, bob);

        vm.prank(alice);
        arena.createDuel(aliceAgentId, bobAgentId, 1 ether, 1 hours);

        PvPArena.Duel memory duel = arena.getDuel(0);

        assertEq(duel.agentAId, aliceAgentId);
        assertEq(duel.agentBId, bobAgentId);
        assertEq(duel.stakeAmount, 1 ether);
        assertEq(duel.duration, 1 hours);
        assertGt(duel.startTime, 0);
        assertFalse(duel.resolved);
    }

    function test_submitPerformanceAndResolve() public {
        // Setup: register + duel
        vm.prank(alice);
        arena.registerAgent(aliceAgentId, alice);
        vm.prank(bob);
        arena.registerAgent(bobAgentId, bob);

        vm.prank(alice);
        arena.createDuel(aliceAgentId, bobAgentId, 1 ether, 1 hours); // 1h for fast test

        // Alice submits performance
        vm.prank(alice);
        arena.submitPerformance(0, int256(2 ether), 1500); // +2 ETH, sharpe 1.5

        // Check agent stats updated
        PvPArena.ArenaAgent memory agAlice = arena.getAgent(aliceAgentId);
        assertEq(agAlice.tradeCount, 1);

        // Bob submits — duel auto-resolves after time passes
        vm.prank(bob);
        arena.submitPerformance(0, int256(1 ether), 1000); // +1 ETH, sharpe 1.0

        // Fast-forward past duel end
        vm.warp(block.timestamp + 1 hours + 1);

        arena.forceResolveDuel(0);

        // Verify duel resolved
        PvPArena.Duel memory resolvedDuel = arena.getDuel(0);
        assertTrue(resolvedDuel.resolved);
    }

    function test_cannotRegisterNonERC8004Agent() public {
        vm.prank(alice);
        // aliceAgentId + 99 is not registered in ERC-8004
        vm.expectRevert(PvPArena.AgentNotRegistered.selector);
        arena.registerAgent(aliceAgentId + 99, alice);
    }

    function test_onlyAgentWalletCanSubmit() public {
        vm.prank(alice);
        arena.registerAgent(aliceAgentId, alice);
        vm.prank(bob);
        arena.registerAgent(bobAgentId, bob);

        vm.prank(alice);
        arena.createDuel(aliceAgentId, bobAgentId, 1 ether, 1 hours);

        // Carol (stranger) cannot submit for alice's duel
        address carol = makeAddr("carol");
        vm.prank(carol);
        vm.expectRevert(PvPArena.CallerNotAgentWallet.selector);
        arena.submitPerformance(0, int256(1 ether), 1000);
    }

    function test_leaderboardSortsByRiskAdjustedScore() public {
        // Deploy extra wallets
        address c = makeAddr("c");
        address d = makeAddr("d");

        // Register 3 more agents
        uint256 cId;
        uint256 dId;
        vm.prank(c); cId = identityRegistry.register("ipfs://c.json");
        vm.prank(d); dId = identityRegistry.register("ipfs://d.json");

        // Register all in arena
        vm.prank(alice); arena.registerAgent(aliceAgentId, alice);
        vm.prank(bob);   arena.registerAgent(bobAgentId, bob);
        vm.prank(c);     arena.registerAgent(cId, c);
        vm.prank(d);     arena.registerAgent(dId, d);

        // Create duels: alice vs bob, and carol vs dave
        vm.prank(alice);
        arena.createDuel(aliceAgentId, bobAgentId, 1 ether, 1 hours);
        vm.prank(c);
        arena.createDuel(cId, dId, 1 ether, 1 hours);

        // Submit different performance levels
        // Alice: +10 ETH, sharpe 2.0 → score: 10 * 2.0 = 20
        vm.prank(alice);
        arena.submitPerformance(0, int256(10 ether), 2000);

        // Bob: +5 ETH, sharpe 1.0 → score: 5 * 1.0 = 5
        vm.prank(bob);
        arena.submitPerformance(0, int256(5 ether), 1000);

        // Carol: +3 ETH, sharpe 3.0 → score: 3 * 3.0 = 9
        vm.prank(c);
        arena.submitPerformance(1, int256(3 ether), 3000);

        int256 aliceScore = arena.getAgentScore(aliceAgentId);
        int256 carolScore = arena.getAgentScore(cId);
        int256 bobScore = arena.getAgentScore(bobAgentId);
        assertGt(aliceScore, carolScore);
        assertGt(carolScore, bobScore);
    }
}
