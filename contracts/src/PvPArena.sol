// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title PvPArena — Agent Competition Arena with ERC-8004 Identity Integration
/// @notice Head-to-head agent competition with persistent on-chain leaderboard.
///         Agents must be ERC-8004 registered to participate.
///         Deployed on Base L2 (Aerodrome-compatible).
/// @dev PvP format inspired by DegenDomeSolana — agents compete on
///      risk-adjusted performance over a defined duel duration.

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

interface IERC8004IdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
    function agentWallets(uint256 agentId) external view returns (address);
}

contract PvPArena is ERC721URIStorage {
    // ─── Errors ────────────────────────────────────────────────────────────
    error AgentNotRegistered();
    error AgentNotActive();
    error CallerNotAgentWallet();
    error DuelAlreadyResolved();
    error DuelNotFound();
    error StakeAmountZero();
    error DuelsFull();

    // ─── State ─────────────────────────────────────────────────────────────
    uint256 public constant DEFAULT_DUEL_DURATION = 7 days;
    uint256 public constant MIN_DUEL_DURATION = 1 hours;
    uint256 public constant MAX_DUEL_DURATION = 30 days;
    uint256 public constant MAX_ACTIVE_DUELS_PER_AGENT = 5;

    /// Maps agent ERC-8004 tokenId → ArenaAgent
    mapping(uint256 => ArenaAgent) public agents;
    /// Maps duelId → Duel
    mapping(uint256 => Duel) public duels;
    /// Tracks how many active duels each agent has
    mapping(uint256 => uint256) public activeDuelCount;

    uint256 public duelCount;
    uint256 public registeredAgentCount;

    /// The ERC-8004 Identity Registry on this chain
    address public identityRegistry;

    // ─── Structs ───────────────────────────────────────────────────────────
    struct ArenaAgent {
        address wallet;          // agent's controlling wallet
        int256 totalPnL;         // cumulative PnL in wei (signed)
        uint256 sharpeRatio;     // scaled by 1000 (e.g. 1500 = 1.5)
        int256 maxDrawdown;      // worst drawdown as negative wei
        uint256 tradeCount;
        uint256 wins;
        uint256 losses;
        uint256 lastUpdate;
        bool isActive;
        uint256 erc8004TokenId;  // link back to ERC-8004 identity
    }

    struct Duel {
        uint256 id;
        uint256 agentAId;        // ERC-8004 tokenId
        uint256 agentBId;        // ERC-8004 tokenId
        uint256 stakeAmount;     // wei
        int256 agentAScore;     // risk-adjusted score at resolution
        int256 agentBScore;
        int256 agentAPnL;        // raw PnL for this duel
        int256 agentBPnL;
        bytes32 winner;          // ERC-8004 tokenId of winner (0 = tie/inconclusive)
        uint256 startTime;
        uint256 endTime;         // 0 = not resolved
        uint256 duration;       // seconds
        bool resolved;
    }

    // ─── Events ────────────────────────────────────────────────────────────
    event ArenaDeployed(address indexed identityRegistry, address deployer);
    event AgentRegistered(uint256 indexed erc8004TokenId, address wallet);
    event DuelCreated(uint256 indexed duelId, uint256 indexed agentAId, uint256 indexed agentBId, uint256 stake, uint256 duration);
    event PerformanceSubmitted(uint256 indexed duelId, uint256 indexed agentId, int256 pnl, uint256 sharpe);
    event DuelResolved(uint256 indexed duelId, bytes32 winner, int256 agentAScore, int256 agentBScore);
    event AgentUpdated(uint256 indexed erc8004TokenId, int256 newPnL, uint256 newSharpe);

    // ─── Modifiers ────────────────────────────────────────────────────────
    modifier onlyAgentWallet(uint256 agentId) {
        _onlyAgentWallet(agentId);
        _;
    }

    modifier onlyRegisteredAgent(uint256 agentId) {
        _onlyRegisteredAgent(agentId);
        _;
    }

    function _onlyAgentWallet(uint256 agentId) internal view {
        if (msg.sender != agents[agentId].wallet) revert CallerNotAgentWallet();
    }

    function _onlyRegisteredAgent(uint256 agentId) internal view {
        if (!agents[agentId].isActive) revert AgentNotActive();
    }

    // ─── Deployment ───────────────────────────────────────────────────────
    constructor(address _identityRegistry) ERC721("PvP Arena", "PVP-ARENA") {
        require(_identityRegistry != address(0), "Invalid identity registry");
        identityRegistry = _identityRegistry;
        emit ArenaDeployed(_identityRegistry, msg.sender);
    }

    // ─── Agent Management ──────────────────────────────────────────────────

    /// @notice Register an agent for the arena.
    ///         Agent must already be registered in the ERC-8004 Identity Registry.
    /// @param  erc8004TokenId  The agent's ERC-8004 tokenId on this chain.
    /// @param  wallet          The agent's controlling wallet address.
    function registerAgent(uint256 erc8004TokenId, address wallet) external {
        require(wallet != address(0), "Invalid wallet");

        // Verify the agent is ERC-8004 registered via this chain's registry
        try IERC8004IdentityRegistry(identityRegistry).ownerOf(erc8004TokenId) returns (address owner) {
            require(owner == wallet || IERC8004IdentityRegistry(identityRegistry).agentWallets(erc8004TokenId) == wallet,
                "Wallet does not match ERC-8004 registration");
        } catch {
            revert AgentNotRegistered();
        }

        ArenaAgent storage agent = agents[erc8004TokenId];
        require(!agent.isActive, "Agent already registered in arena");

        agent.wallet = wallet;
        agent.isActive = true;
        agent.lastUpdate = block.timestamp;
        agent.erc8004TokenId = erc8004TokenId;
        registeredAgentCount++;

        emit AgentRegistered(erc8004TokenId, wallet);
    }

    /// @notice Update agent's wallet (must be called by current wallet)
    function updateWallet(uint256 agentId, address newWallet) external onlyAgentWallet(agentId) {
        require(newWallet != address(0), "Invalid wallet");
        agents[agentId].wallet = newWallet;
    }

    /// @notice Deactivate an agent (voluntary withdrawal)
    function deactivateAgent(uint256 agentId) external onlyAgentWallet(agentId) {
        require(activeDuelCount[agentId] == 0, "Cannot deactivate with active duels");
        agents[agentId].isActive = false;
    }

    // ─── Duel Management ──────────────────────────────────────────────────

    /// @notice Create a duel. Both agents must be ERC-8004 registered and active.
    /// @param  agentAId  ERC-8004 tokenId of agent A
    /// @param  agentBId  ERC-8004 tokenId of agent B
    /// @param  stake     Wei amount staked (both agents match this)
    /// @param  duration  Duel duration in seconds (default: 7 days)
    function createDuel(
        uint256 agentAId,
        uint256 agentBId,
        uint256 stake,
        uint256 duration
    ) external {
        require(agents[agentAId].isActive && agents[agentBId].isActive, "Agent not active");
        require(agentAId != agentBId, "Cannot duel self");
        require(stake > 0, "Stake must be > 0");
        require(duration >= MIN_DUEL_DURATION && duration <= MAX_DUEL_DURATION, "Invalid duration");
        require(activeDuelCount[agentAId] < MAX_ACTIVE_DUELS_PER_AGENT, "Agent A has too many active duels");
        require(activeDuelCount[agentBId] < MAX_ACTIVE_DUELS_PER_AGENT, "Agent B has too many active duels");

        uint256 duelId = duelCount++;
        duels[duelId] = Duel({
            id: duelId,
            agentAId: agentAId,
            agentBId: agentBId,
            stakeAmount: stake,
            agentAScore: 0,
            agentBScore: 0,
            agentAPnL: 0,
            agentBPnL: 0,
            winner: bytes32(0),
            startTime: block.timestamp,
            endTime: 0,
            duration: duration == 0 ? DEFAULT_DUEL_DURATION : duration,
            resolved: false
        });

        activeDuelCount[agentAId]++;
        activeDuelCount[agentBId]++;

        emit DuelCreated(duelId, agentAId, agentBId, stake, duels[duelId].duration);
    }

    /// @notice Submit performance for an active duel.
    ///         Can be called by either agent's wallet as many times as needed.
    ///         Resolves the duel when: time expired OR both agents have submitted.
    /// @param  duelId    The duel to submit performance for
    /// @param  pnl       Agent's PnL for this duel (in wei, can be negative)
    /// @param  sharpe    Agent's Sharpe ratio for this duel (scaled by 1000)
    function submitPerformance(
        uint256 duelId,
        int256 pnl,
        uint256 sharpe
    ) external {
        Duel storage duel = duels[duelId];
        if (duel.resolved) revert DuelAlreadyResolved();
        if (duel.id != duelId) revert DuelNotFound();

        uint256 callerAgentId;
        if (msg.sender == agents[duel.agentAId].wallet) {
            callerAgentId = duel.agentAId;
        } else if (msg.sender == agents[duel.agentBId].wallet) {
            callerAgentId = duel.agentBId;
        } else {
            revert CallerNotAgentWallet();
        }

        // Update arena agent stats
        ArenaAgent storage agent = agents[callerAgentId];
        agent.totalPnL += pnl;
        agent.sharpeRatio = (agent.sharpeRatio * agent.tradeCount + sharpe) / (agent.tradeCount + 1);
        agent.tradeCount++;
        agent.lastUpdate = block.timestamp;

        if (callerAgentId == duel.agentAId) {
            duel.agentAPnL = pnl;
            duel.agentAScore = _computeRiskAdjustedScore(pnl, sharpe, agent.maxDrawdown);
        } else {
            duel.agentBPnL = pnl;
            duel.agentBScore = _computeRiskAdjustedScore(pnl, sharpe, agent.maxDrawdown);
        }

        emit PerformanceSubmitted(duelId, callerAgentId, pnl, sharpe);
        emit AgentUpdated(callerAgentId, agent.totalPnL, agent.sharpeRatio);

        // Auto-resolve if time expired
        if (block.timestamp >= duel.startTime + duel.duration) {
            _resolveDuel(duelId);
        }
    }

    /// @notice Manually resolve a duel (any caller, after duration)
    ///         Resolves immediately if both agents have submitted performance.
    function forceResolveDuel(uint256 duelId) external {
        Duel storage duel = duels[duelId];
        if (duel.resolved) revert DuelAlreadyResolved();
        if (duel.id != duelId) revert DuelNotFound();

        bool bothSubmitted = duel.agentAPnL != 0 && duel.agentBPnL != 0;
        bool timeExpired = block.timestamp >= duel.startTime + duel.duration;

        require(bothSubmitted || timeExpired, "Duel not ready to resolve");

        _resolveDuel(duelId);
    }

    /// @notice Resolve the duel, credit wins/losses, free up active duel slots.
    function _resolveDuel(uint256 duelId) internal {
        Duel storage duel = duels[duelId];
        duel.resolved = true;
        duel.endTime = block.timestamp;

        // Determine winner by risk-adjusted score
        if (duel.agentAScore > duel.agentBScore) {
            duel.winner = bytes32(uint256(duel.agentAId));
            agents[duel.agentAId].wins++;
            agents[duel.agentBId].losses++;
        } else if (duel.agentBScore > duel.agentAScore) {
            duel.winner = bytes32(uint256(duel.agentBId));
            agents[duel.agentBId].wins++;
            agents[duel.agentAId].losses++;
        }
        // ties: no winner credited

        // Free up active duel slots
        activeDuelCount[duel.agentAId] = activeDuelCount[duel.agentAId] > 0
            ? activeDuelCount[duel.agentAId] - 1 : 0;
        activeDuelCount[duel.agentBId] = activeDuelCount[duel.agentBId] > 0
            ? activeDuelCount[duel.agentBId] - 1 : 0;

        emit DuelResolved(duelId, duel.winner, duel.agentAScore, duel.agentBScore);
    }

    // ─── Risk-Adjusted Score ──────────────────────────────────────────────
    /// @notice Compute risk-adjusted score: (pnl * sharpe) / (1 + |drawdown|)
    ///         Result scaled by 1e18 for precision.
    function _computeRiskAdjustedScore(int256 pnl, uint256 sharpe, int256 maxDrawdown) internal pure returns (int256) {
        int256 divisor = 1e18 + (maxDrawdown < 0 ? -maxDrawdown : maxDrawdown);
        // sharpe is scaled by 1000 (e.g. 1500 = 1.5)
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 scaledSharpe = int256(sharpe) * 1e15; // convert to 1e18 scale; uint256 max is << int256 max so safe
        return (pnl * scaledSharpe) / divisor;
    }

    // ─── View Functions ───────────────────────────────────────────────────

    /// @notice Returns all registered agents sorted by risk-adjusted score
    function getLeaderboard() external view returns (ArenaAgent[] memory) {
        uint256 count = registeredAgentCount;
        ArenaAgent[] memory sorted = new ArenaAgent[](count);
        uint256 idx = 0;

        // Collect active agents
        for (uint256 i = 1; i <= 1e6 && idx < count; i++) {
            if (agents[uint256(i)].isActive) {
                sorted[idx++] = agents[uint256(i)];
            }
        }

        // Bubble sort by risk-adjusted score
        for (uint256 i = 0; i < idx; i++) {
            for (uint256 j = i + 1; j < idx; j++) {
                int256 scoreI = _computeRiskAdjustedScore(sorted[i].totalPnL, sorted[i].sharpeRatio, sorted[i].maxDrawdown);
                int256 scoreJ = _computeRiskAdjustedScore(sorted[j].totalPnL, sorted[j].sharpeRatio, sorted[j].maxDrawdown);
                if (scoreJ > scoreI) {
                    ArenaAgent memory tmp = sorted[i];
                    sorted[i] = sorted[j];
                    sorted[j] = tmp;
                }
            }
        }

        return sorted;
    }

    /// @notice Get active duels for an agent
    function getActiveDuels(uint256 agentId) external view returns (Duel[] memory) {
        uint256 count = activeDuelCount[agentId];
        Duel[] memory result = new Duel[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < duelCount && idx < count; i++) {
            Duel storage d = duels[i];
            if (!d.resolved && (d.agentAId == agentId || d.agentBId == agentId)) {
                result[idx++] = d;
            }
        }
        return result;
    }

    /// @notice Get a specific duel
    function getDuel(uint256 duelId) external view returns (Duel memory) {
        return duels[duelId];
    }

    /// @notice Get agent stats by ERC-8004 tokenId
    function getAgent(uint256 agentId) external view returns (ArenaAgent memory) {
        return agents[agentId];
    }

    /// @notice Compute risk-adjusted score for an agent (view function)
    function getAgentScore(uint256 agentId) external view returns (int256) {
        ArenaAgent storage agent = agents[agentId];
        return _computeRiskAdjustedScore(agent.totalPnL, agent.sharpeRatio, agent.maxDrawdown);
    }
}