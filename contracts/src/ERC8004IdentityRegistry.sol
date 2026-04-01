// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

/// @title ERC8004IdentityRegistry — ERC-8004 Identity Registry
/// @notice ERC-721-based identity registry for autonomous agents.
///         Agents are ERC-721 tokens with URI pointing to off-chain registration metadata.
///         This is a per-chain singleton; deploy once per chain.
/// @dev Inherits ERC721URIStorage so tokenURI() returns the agent's registration URI.
contract ERC8004IdentityRegistry is ERC721URIStorage {
    /// @notice Emitted when a new agent registers.
    /// @param agentId  The ERC-721 tokenId assigned to the agent.
    /// @param agentURI Off-chain URI where the full registration JSON lives.
    /// @param owner    The EOA or contract that owns this agent identity.
    event AgentRegistered(uint256 indexed agentId, string agentURI, address indexed owner);

    /// @notice Emitted when an agent's URI is updated.
    /// @param agentId  The agent tokenId.
    /// @param oldURI   The previous URI.
    /// @param newURI   The new URI.
    event AgentURIUpdated(uint256 indexed agentId, string oldURI, string newURI);

    /// @notice Emitted when an agent's wallet address is transferred.
    /// @param agentId     The agent tokenId.
    /// @param oldWallet   Previous wallet address.
    /// @param newWallet   New wallet address.
    event AgentWalletUpdated(uint256 indexed agentId, address oldWallet, address newWallet);

    /// @notice Counter for the next agentId (mirrors ERC-721 tokenId).
    uint256 private _nextAgentId;

    /// @notice Maps agentId => wallet address that can act on behalf of the agent.
    mapping(uint256 => address) public agentWallets;

    /// @notice Maps agentId => metadata key => arbitrary bytes value (extendable).
    mapping(uint256 => mapping(string => bytes)) public metadata;

    constructor() ERC721("ERC-8004 Identity Registry", "ERC-8004-ID") {
        // Agent 0 is reserved (matches the "unregistered" sentinel in your TypeScript).
        _nextAgentId = 1;
    }

    /// @notice Register a new agent. Anyone can call this — there is no allowlist.
    ///         The caller becomes the owner of the new ERC-721 token.
    /// @param  agentURI  Off-chain URI pointing to the agent's registration JSON.
    /// @return agentId   The newly assigned ERC-721 tokenId.
    function register(string calldata agentURI) external returns (uint256 agentId) {
        require(bytes(agentURI).length > 0, "ERC8004: empty URI");

        uint256 id = _nextAgentId++;
        _safeMint(msg.sender, id);
        _setTokenURI(id, agentURI);

        emit AgentRegistered(id, agentURI, msg.sender);
        return id;
    }

    /// @notice Update the URI for an existing agent. Only the token owner can call.
    /// @param agentId The tokenId to update.
    /// @param newURI  The new URI.
    function setAgentURI(uint256 agentId, string calldata newURI) external {
        require(ownerOf(agentId) == msg.sender, "ERC8004: not the owner");
        require(bytes(newURI).length > 0, "ERC8004: empty URI");

        string memory oldURI = tokenURI(agentId);
        _setTokenURI(agentId, newURI);

        emit AgentURIUpdated(agentId, oldURI, newURI);
    }

    /// @notice Store arbitrary key/value metadata for an agent.
    /// @param agentId    The tokenId.
    /// @param metadataKey The metadata key.
    /// @param value       The bytes value to store.
    function setMetadata(
        uint256 agentId,
        string calldata metadataKey,
        bytes calldata value
    ) external {
        require(ownerOf(agentId) == msg.sender, "ERC8004: not the owner");
        metadata[agentId][metadataKey] = value;
    }

    /// @notice Read arbitrary metadata for an agent.
    /// @param agentId    The tokenId.
    /// @param metadataKey The metadata key.
    /// @return The stored bytes value (empty if not set).
    function getMetadata(
        uint256 agentId,
        string calldata metadataKey
    ) external view returns (bytes memory) {
        return metadata[agentId][metadataKey];
    }

    /// @notice Set or transfer the wallet address that can act on behalf of an agent.
    ///         In this minimal implementation we skip EIP-712 signature verification;
    ///         only the current owner can call directly.
    /// @param agentId   The tokenId.
    /// @param newWallet The new wallet address.
    function setAgentWallet(uint256 agentId, address newWallet) external {
        require(ownerOf(agentId) == msg.sender, "ERC8004: not the owner");
        require(newWallet != address(0), "ERC8004: zero wallet");

        address oldWallet = agentWallets[agentId];
        agentWallets[agentId] = newWallet;

        emit AgentWalletUpdated(agentId, oldWallet, newWallet);
    }

    /// @notice Returns the wallet address authorised to act on behalf of an agent.
    /// @param agentId The tokenId.
    /// @return The wallet address, or address(0) if none is set.
    function getAgentWallet(uint256 agentId) external view returns (address) {
        return agentWallets[agentId];
    }
}
