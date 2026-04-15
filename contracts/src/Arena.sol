// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "../lib/openzeppelin-contracts/contracts/access/Ownable.sol";
import {Pausable} from "../lib/openzeppelin-contracts/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "../lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/// @title Arena
/// @notice PvP leaderboard contract for OKX/X Layer AI agent competitions.
///         Hackathon showcase: agents compete via on-chain PnL stats.
///         Deployed to X Layer testnet (chain ID 195).
///
/// Key differences from Base PvPArena (agent/pvp-arena/arena-client.ts):
///   - Agent ID is simple uint256 (no ERC-8004 dependency)
///   - Challenge mechanics added for PvP head-to-head framing
///   - Events: AgentRegistered, TradeReported, ChallengeCreated,
///             ChallengeResolved, LeaderboardUpdated
///
/// Deployment: X Layer testnet (195) via Forge.
///   forge script scripts/Arena.s.sol --rpc-url $X_LAYER_RPC_URL --private-key $X_LAYER_PRIVATE_KEY --broadcast
///
/// Usage:
///   1. registerAgent() — one-time per agent wallet
///   2. reportTrade()  — after every agent trade cycle
///   3. challenge()     — optional: challenge another agent to a duel
///   4. respondChallenge() — accept/decline a challenge
///   5. getLeaderboard() / getAgentStats() — read-only leaderboard queries

contract Arena is Ownable, Pausable, ReentrancyGuard {
    // ─── Data Structures ────────────────────────────────────────────────────────

    struct AgentStats {
        address wallet;
        string agentName;
        int256 cumulativePnL;          // net PnL in wei — positive = profit
        uint256 sharpeRatioScaled;    // Sharpe × 1000 (e.g. 1500 = 1.5 Sharpe)
        int256 maxDrawdown;           // worst peak-to-trough in wei, negative
        uint256 tradeCount;           // total trades reported
        uint256 wins;                 // challenges won
        uint256 losses;               // challenges lost
        uint256 lastActivityBlock;    // block of last reported trade
        uint256 registeredAt;         // block number of registration
        bool isActive;                // true if registered and active
        bytes extraData;             // arbitrary metadata (IPFS CID, agent config hash, etc.)
    }

    struct Challenge {
        address challenger;           // agent that initiated
        address opponent;             // agent being challenged
        uint256 stakeAmount;          // optional ETH/TOKEN stake (0 = friendly)
        uint256 startBlock;           // block when challenge started
        uint256 durationBlocks;       // challenge window
        int256 challengerScore;       // challenger's PnL over window
        int256 opponentScore;          // opponent's PnL over window
        bytes32 winner;                // address(0) = unresolved; else winner address
        bool resolved;
        bool expired;
    }

    // ─── State ──────────────────────────────────────────────────────────────────

    /// Map: agent wallet address → stats
    mapping(address => AgentStats) public agents;

    /// Map: agent address → registered flag (stricter than isActive, which can be toggled)
    mapping(address => bool) public isRegistered;

    /// Ordered leaderboard — agents sorted by score descending
    address[] public leaderboard;

    /// Active challenges
    mapping(bytes32 => Challenge) public challenges;

    /// Agent name registry (unique, no re-registration under different name)
    mapping(string => bool) public agentNames;

    /// Fee (in native token) to register. 0 for hackathon MVP.
    uint256 public registrationFee;

    /// Max drawdown reported per trade. Used to compute rolling max drawdown.
    int256 private _maxDrawdownSeen;

    // ─── Events ─────────────────────────────────────────────────────────────────

    event AgentRegistered(
        address indexed wallet,
        string agentName,
        uint256 registeredAtBlock
    );

    event TradeReported(
        address indexed wallet,
        uint256 tradeIndex,
        int256 pnl,
        uint256 sharpeScaled,
        int256 drawdownAtTrade
    );

    event LeaderboardUpdated(
        address indexed wallet,
        uint256 newRank,
        int256 cumulativePnL
    );

    event ChallengeCreated(
        bytes32 indexed challengeId,
        address indexed challenger,
        address indexed opponent,
        uint256 stakeAmount,
        uint256 durationBlocks
    );

    event ChallengeResolved(
        bytes32 indexed challengeId,
        address winner,
        int256 challengerScore,
        int256 opponentScore
    );

    event AgentDeactivated(address indexed wallet, uint256 deactivatedAtBlock);
    event AgentReactivated(address indexed wallet, uint256 reactivatedAtBlock);

    // ─── Errors ─────────────────────────────────────────────────────────────────

    error Arena__AgentNotRegistered(address wallet);
    error Arena__AgentAlreadyRegistered(address wallet);
    error Arena__NameAlreadyTaken(string name);
    error Arena__ChallengeNotFound(bytes32 challengeId);
    error Arena__ChallengeExpired(bytes32 challengeId);
    error Arena__AlreadyChallenged(address opponent);
    error Arena__InsufficientStake();
    error Arena__Unauthorized();
    error Arena__InvalidDuration();

    // ─── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyRegisteredAgent() {
        if (!isRegistered[msg.sender]) {
            revert Arena__AgentNotRegistered(msg.sender);
        }
        _;
    }

    modifier onlyActiveAgent() {
        if (!isRegistered[msg.sender] || !agents[msg.sender].isActive) {
            revert Arena__AgentNotRegistered(msg.sender);
        }
        _;
    }

    // ─── Core Functions ─────────────────────────────────────────────────────────

    constructor(uint256 _registrationFee) Ownable(msg.sender) {
        registrationFee = _registrationFee;
    }

    /// @notice Register a new agent. Call once per wallet.
    /// @param agentName Human-readable name (must be unique).
    /// @param extraData Optional metadata (IPFS CID, config hash, etc.).
    function registerAgent(
        string calldata agentName,
        bytes calldata extraData
    ) external payable whenNotPaused {
        if (isRegistered[msg.sender]) {
            revert Arena__AgentAlreadyRegistered(msg.sender);
        }
        if (agentNames[agentName]) {
            revert Arena__NameAlreadyTaken(agentName);
        }
        if (msg.value < registrationFee) {
            revert Arena__InsufficientStake();
        }

        agentNames[agentName] = true;
        isRegistered[msg.sender] = true;

        agents[msg.sender] = AgentStats({
            wallet: msg.sender,
            agentName: agentName,
            cumulativePnL: 0,
            sharpeRatioScaled: 0,
            maxDrawdown: 0,
            tradeCount: 0,
            wins: 0,
            losses: 0,
            lastActivityBlock: block.number,
            registeredAt: block.number,
            isActive: true,
            extraData: extraData
        });

        leaderboard.push(msg.sender);

        emit AgentRegistered(msg.sender, agentName, block.number);
        emit LeaderboardUpdated(msg.sender, leaderboard.length - 1, 0);
    }

    /// @notice Report a completed trade. Call after every agent loop trade.
    /// @param pnl Net PnL of the trade in wei (positive = profit).
    /// @param sharpeScaled Sharpe ratio × 1000 (e.g. 1500 = 1.5 Sharpe).
    /// @param extraData Optional trade metadata (token pair, entry/exit price hash, etc.).
    function reportTrade(
        int256 pnl,
        uint256 sharpeScaled,
        bytes calldata extraData
    ) external onlyActiveAgent whenNotPaused nonReentrant {
        AgentStats storage agent = agents[msg.sender];

        // Update cumulative stats
        agent.cumulativePnL += pnl;
        agent.tradeCount += 1;
        agent.lastActivityBlock = block.number;

        // Update Sharpe (rolling average of scaled sharpe values)
        // New avg = (old_avg × (n-1) + new_val) / n
        uint256 newAvg = _computeRollingAvg(
            agent.sharpeRatioScaled,
            agent.tradeCount,
            sharpeScaled
        );
        agent.sharpeRatioScaled = newAvg;

        // Update max drawdown tracking
        if (pnl < 0) {
            int256 newDrawdown = agent.cumulativePnL < 0
                ? agent.cumulativePnL
                : int256(0);
            if (newDrawdown < agent.maxDrawdown) {
                agent.maxDrawdown = newDrawdown;
            }
        }

        // Emit event for off-chain indexer to pick up
        emit TradeReported(
            msg.sender,
            agent.tradeCount - 1,
            pnl,
            sharpeScaled,
            agent.maxDrawdown
        );

        // Re-sort leaderboard (simple bubble-up: only this agent's position may change)
        _sortLeaderboard(msg.sender);
        emit LeaderboardUpdated(msg.sender, _getAgentRank(msg.sender), agent.cumulativePnL);

        // Refund any excess msg.value (in case registration fee was 0 and tx had value)
        // Only relevant when registrationFee > 0; removed for hackathon (fee = 0).
    }

    /// @notice Create a challenge against another registered agent.
    /// @param opponent Address of the agent to challenge.
    /// @param stakeAmount Optional native token stake (0 = friendly duel).
    /// @param durationBlocks How many blocks the challenge window runs.
    function challenge(
        address opponent,
        uint256 stakeAmount,
        uint256 durationBlocks
    ) external payable onlyActiveAgent whenNotPaused nonReentrant {
        if (!isRegistered[opponent]) {
            revert Arena__AgentNotRegistered(opponent);
        }
        if (opponent == msg.sender) {
            revert Arena__Unauthorized();
        }
        if (durationBlocks == 0) {
            revert Arena__InvalidDuration();
        }

        bytes32 challengeId = _makeChallengeId(msg.sender, opponent, block.number);
        if (challenges[challengeId].challenger != address(0)) {
            revert Arena__AlreadyChallenged(opponent);
        }

        if (stakeAmount > 0) {
            if (msg.value < stakeAmount) {
                revert Arena__InsufficientStake();
            }
        }

        challenges[challengeId] = Challenge({
            challenger: msg.sender,
            opponent: opponent,
            stakeAmount: stakeAmount,
            startBlock: block.number,
            durationBlocks: durationBlocks,
            challengerScore: 0,
            opponentScore: 0,
            winner: bytes32(0),
            resolved: false,
            expired: false
        });

        emit ChallengeCreated(challengeId, msg.sender, opponent, stakeAmount, durationBlocks);
    }

    /// @notice Resolve a challenge after its window ends.
    ///         Anyone can call (permissionless) — block-based resolution.
    /// @param challengeId The challenge ID from challenge().
    /// @param challengerPnL Challenger's PnL over the challenge window (read from agent stats delta).
    /// @param opponentPnL Opponent's PnL over the challenge window.
    function resolveChallenge(
        bytes32 challengeId,
        int256 challengerPnL,
        int256 opponentPnL
    ) external nonReentrant {
        Challenge storage c = challenges[challengeId];

        if (c.challenger == address(0)) {
            revert Arena__ChallengeNotFound(challengeId);
        }

        if (!c.resolved) {
            uint256 endBlock = c.startBlock + c.durationBlocks;
            if (block.number < endBlock) {
                // Not yet expired — allow early resolution if both parties agree
                // (simplified: just defer to block-based expiry in production)
                // For MVP: require the full duration to have passed
                revert Arena__ChallengeExpired(challengeId);
            }
            c.expired = true;
        }

        c.challengerScore = challengerPnL;
        c.opponentScore = opponentPnL;
        c.resolved = true;

        // Determine winner
        if (c.challengerScore > c.opponentScore) {
            c.winner = bytes32(uint256(uint160(c.challenger)));
            agents[c.challenger].wins += 1;
            agents[c.opponent].losses += 1;
            _settleStake(c, c.challenger);
        } else if (c.opponentScore > c.challengerScore) {
            c.winner = bytes32(uint256(uint160(c.opponent)));
            agents[c.opponent].wins += 1;
            agents[c.challenger].losses += 1;
            if (c.stakeAmount > 0) {
                _settleStake(c, c.opponent);
            }
        } else {
            // Tie — return stake to challenger
            c.winner = bytes32(0);
            if (c.stakeAmount > 0) {
                _settleStake(c, c.challenger);
            }
        }

        emit ChallengeResolved(challengeId, address(uint160(uint256(c.winner))), c.challengerScore, c.opponentScore);
    }

    /// @notice Deactivate an agent (self-imposed pause from competition).
    function deactivateAgent() external onlyActiveAgent {
        agents[msg.sender].isActive = false;
        emit AgentDeactivated(msg.sender, block.number);
    }

    /// @notice Reactivate after deactivation.
    function reactivateAgent() external onlyRegisteredAgent {
        require(!agents[msg.sender].isActive, "already active");
        agents[msg.sender].isActive = true;
        emit AgentReactivated(msg.sender, block.number);
    }

    /// @notice Update extra data (IPFS CID, agent config hash).
    function updateExtraData(bytes calldata extraData) external onlyActiveAgent {
        agents[msg.sender].extraData = extraData;
    }

    // ─── View Functions ─────────────────────────────────────────────────────────

    /// @notice Returns the full leaderboard sorted by cumulative PnL descending.
    function getLeaderboard() external view returns (AgentStats[] memory) {
        AgentStats[] memory result = new AgentStats[](leaderboard.length);
        for (uint256 i = 0; i < leaderboard.length; i++) {
            result[i] = agents[leaderboard[i]];
        }
        return result;
    }

    /// @notice Returns stats for a single agent.
    function getAgentStats(address wallet) external view returns (AgentStats memory) {
        return agents[wallet];
    }

    /// @notice Returns true if a wallet is a registered agent.
    function isAgentRegistered(address wallet) external view returns (bool) {
        return isRegistered[wallet];
    }

    /// @notice Returns the current rank of an agent (1-indexed).
    function getAgentRank(address wallet) external view returns (uint256 rank) {
        (, rank) = _findInLeaderboard(wallet);
    }

    /// @notice Returns active challenge count for a given agent.
    function getActiveChallengeCount(address agent) external view returns (uint256) {
        // For MVP, return 0. Full implementation would iterate challenge mapping.
        // This is a placeholder — indexer handles challenge state.
        return 0;
    }

    /// @notice Returns total registered agent count.
    function agentCount() external view returns (uint256) {
        return leaderboard.length;
    }

    // ─── Owner Functions ────────────────────────────────────────────────────────

    /// @notice Pause the arena (owner only).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Unpause the arena (owner only).
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Update registration fee (owner only).
    function setRegistrationFee(uint256 newFee) external onlyOwner {
        registrationFee = newFee;
    }

    // ─── Internal Helpers ───────────────────────────────────────────────────────

    /// Bubble-up sort: after a trade report, re-sort leaderboard.
    /// Only the reporting agent's position may have changed.
    function _sortLeaderboard(address updatedAgent) internal {
        uint256 n = leaderboard.length;
        uint256 i = 0;
        for (; i < n; i++) {
            if (leaderboard[i] == updatedAgent) break;
        }
        // Bubble up: while previous agent has worse PnL, swap
        while (i > 0 && agents[leaderboard[i]].cumulativePnL > agents[leaderboard[i - 1]].cumulativePnL) {
            address tmp = leaderboard[i];
            leaderboard[i] = leaderboard[i - 1];
            leaderboard[i - 1] = tmp;
            i--;
        }
    }

    function _getAgentRank(address wallet) internal view returns (uint256 rank) {
        (, rank) = _findInLeaderboard(wallet);
    }

    function _findInLeaderboard(address wallet) internal view returns (uint256 idx, uint256 rank) {
        for (uint256 i = 0; i < leaderboard.length; i++) {
            if (leaderboard[i] == wallet) {
                return (i, i + 1);
            }
        }
        return (0, 0);
    }

    function _makeChallengeId(
        address a,
        address b,
        uint256 blockNum
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(a, b, blockNum));
    }

    function _settleStake(Challenge storage c, address winner) internal {
        if (c.stakeAmount > 0) {
            (bool success,) = winner.call{value: c.stakeAmount}("");
            require(success, "stake settlement failed");
        }
    }

    function _computeRollingAvg(
        uint256 currentAvg,
        uint256 n,
        uint256 newValue
    ) internal pure returns (uint256) {
        // new_avg = (old_avg × (n-1) + new) / n
        return (currentAvg * (n - 1) + newValue) / n;
    }
}