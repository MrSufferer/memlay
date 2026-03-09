/**
 * MemoryVault Agent Protocol — Standard Tool Interface
 *
 * This is the core contract that every pluggable tool must implement.
 * It defines the request/response types, opportunity scoring separation,
 * exit signals, and tool registration schema.
 *
 * KEY DESIGN PRINCIPLES:
 * 1. Tools return RawOpportunity[] (no scores) — scoring is the Skill's job
 * 2. scan/monitor are tool-owned (CRE cron workflows, no ToolRequest needed)
 * 3. enter/exit are agent-owned (agent constructs ToolRequest, executes via ACE)
 * 4. Tool-specific data lives in Record<string, unknown> fields (extensible)
 * 5. Adding a new tool requires 0 changes to agent skills or protocol workflows
 *
 * @module protocol/tool-interface
 */

// ═══════════════════════════════════════════════════════════════════════════
// Action Types & Trigger Model
// ═══════════════════════════════════════════════════════════════════════════

/**
 * All possible tool actions.
 *
 * | Action    | Trigger  | Who Executes       | Accepts ToolRequest? |
 * |-----------|----------|--------------------|----------------------|
 * | `scan`    | Cron     | Tool CRE workflow  | No — runs autonomously |
 * | `monitor` | Cron     | Tool CRE workflow  | No — runs autonomously |
 * | `enter`   | HTTP     | Agent via ACE      | Yes — agent constructs |
 * | `exit`    | HTTP     | Agent via ACE      | Yes — agent constructs |
 */
export type ToolAction = 'scan' | 'enter' | 'exit' | 'monitor'

/** Actions that are tool-owned (run as CRE cron workflows autonomously) */
export type ToolOwnedAction = 'scan' | 'monitor'

/** Actions that are agent-owned (agent decides when to act) */
export type AgentOwnedAction = 'enter' | 'exit'

// ═══════════════════════════════════════════════════════════════════════════
// Tool Request (agent → tool, HTTP-triggered actions only)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ToolRequest — used by HTTP-triggered actions (enter, exit).
 *
 * Cron-triggered actions (scan, monitor) run autonomously and do NOT consume
 * a ToolRequest; they are initiated by CRE cron triggers and return a
 * ToolResponse directly.
 */
export interface ToolRequest {
    /** The action to perform */
    action: ToolAction
    /** Unique agent identifier (scopes storage + on-chain commitments) */
    agentId: string
    /** Strategy type from the trader template (e.g., 'clmm_lp', 'hold_til_dump') */
    strategyType: string
    /** Tool-specific parameters (extensible) */
    params: Record<string, unknown>
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Response (tool → agent/protocol)
// ═══════════════════════════════════════════════════════════════════════════

/** Response status from a tool action */
export type ToolResponseStatus = 'success' | 'failed' | 'no_action'

/**
 * ToolResponse — the standard response from any tool action.
 *
 * Every tool action (scan, monitor, enter, exit) returns this shape.
 * `opportunities` is populated by scan actions; `exitSignals` by monitor actions.
 */
export interface ToolResponse {
    /** Whether the action succeeded */
    status: ToolResponseStatus
    /** Which action produced this response */
    action: string
    /** Which tool produced this response */
    toolId: string
    /** Tool-specific result data (extensible) */
    data: Record<string, unknown>
    /** Raw opportunities from scan action (unscored — skill handles scoring) */
    opportunities?: RawOpportunity[]
    /** Exit signals from monitor action */
    exitSignals?: ExitSignal[]
}

// ═══════════════════════════════════════════════════════════════════════════
// Opportunities (Tool → Skill pipeline)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * RawOpportunity — returned by a TOOL's scan action.
 *
 * Contains tool-specific data in `entryParams` but NO scores.
 * Scoring is the Risk Analysis Skill's responsibility, not the tool's.
 * This separation means the same scoring logic works for any tool.
 */
export interface RawOpportunity {
    /** Which tool found this opportunity */
    toolId: string
    /** Unique identifier for the asset/pool/position */
    assetId: string
    /** Tool-specific entry parameters (pool data, trust signals, etc.) */
    entryParams: Record<string, unknown>
}

/** Risk level classification assigned by the Risk Analysis Skill */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'SCAM'

/**
 * ScoredOpportunity — produced by the RISK ANALYSIS SKILL.
 *
 * Extends RawOpportunity with scores, risk classification, and LLM reasoning.
 * The agent's Decision Skill uses these fields to filter and rank opportunities.
 *
 * Filtering thresholds (from agent decision logic):
 * - opportunityScore >= 80
 * - trustScore >= 75
 * - riskLevel !== 'SCAM'
 */
export interface ScoredOpportunity extends RawOpportunity {
    /** Opportunity quality score 0-100 (from Risk Analysis Skill) */
    opportunityScore: number
    /** Trust/safety score 0-100 (from Risk Analysis Skill) */
    trustScore: number
    /** Risk classification (from Risk Analysis Skill) */
    riskLevel: RiskLevel
    /** LLM-generated explanation of the scoring decision */
    reasoning: string
}

// ═══════════════════════════════════════════════════════════════════════════
// Exit Signals (Tool Monitor → Agent)
// ═══════════════════════════════════════════════════════════════════════════

/** Urgency level for exit signals */
export type ExitUrgency = 'low' | 'medium' | 'high' | 'critical'

/**
 * ExitSignal — returned by a tool's monitor action when an exit trigger fires.
 *
 * The agent's Decision Skill uses these to decide whether to exit a position.
 * Multiple signals can fire simultaneously (e.g., APY drop + TVL crash).
 */
export interface ExitSignal {
    /** Which trigger fired (e.g., 'apy_drop', 'whale_accumulation', 'tvl_crash') */
    trigger: string
    /** How urgently the agent should act */
    urgency: ExitUrgency
    /** Trigger-specific data (thresholds, current values, etc.) */
    data: Record<string, unknown>
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Registration Schema
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ToolRegistration — describes a pluggable tool's identity and capabilities.
 *
 * Used by the agent's Skills Engine to discover and interact with tools.
 * Each tool registers once; the agent iterates `template.strategy.tools`
 * and looks up the registration to find workflow paths and supported actions.
 *
 * Directory structure convention:
 * ```
 * cre-memoryvault/tools/<toolId>/
 * ├── scanner.ts          # scan action (Cron — tool-owned)
 * ├── monitor.ts          # monitor action (Cron — tool-owned)
 * ├── types.ts            # tool-specific types extending ToolRequest/ToolResponse
 * ├── config.staging.json
 * └── workflow.yaml
 * ```
 */
export interface ToolRegistration {
    /** Unique tool identifier (e.g., 'uniswap-v3-lp', 'aave-lending') */
    toolId: string
    /** Human-readable tool name */
    name: string
    /** Brief description of what the tool does */
    description: string
    /** Which actions this tool supports */
    supportedActions: ToolAction[]
    /** Path to the tool's workflow directory (relative to cre-memoryvault/) */
    workflowPath: string
    /** Tool-specific default configuration */
    defaultConfig?: Record<string, unknown>
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Registry (runtime lookup)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ToolRegistry — in-memory registry of all available tools.
 *
 * The agent loads this at startup to discover tool capabilities.
 * Adding a new tool = adding an entry here + creating the workflow directory.
 */
export type ToolRegistry = Map<string, ToolRegistration>

/**
 * Creates a ToolRegistry from an array of registrations.
 * Validates that toolIds are unique.
 */
export function createToolRegistry(tools: ToolRegistration[]): ToolRegistry {
    const registry: ToolRegistry = new Map()
    for (const tool of tools) {
        if (registry.has(tool.toolId)) {
            throw new Error(`Duplicate toolId in registry: ${tool.toolId}`)
        }
        registry.set(tool.toolId, tool)
    }
    return registry
}

// ═══════════════════════════════════════════════════════════════════════════
// MemoryVault Entry Types (for memory-writer workflow)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * MemoryEntry — the payload sent to the memory-writer protocol workflow.
 *
 * Every agent action that modifies state MUST commit a MemoryEntry first.
 * The memory-writer encrypts it (AES-GCM), stores to S3, and hashes on-chain.
 */
export interface MemoryEntry {
    /** Which agent is committing this entry */
    agentId: string
    /** Unique key for this entry (e.g., 'lp-entry-2026-03-02T10:14:05Z') */
    entryKey: string
    /** The data to commit */
    entryData: MemoryEntryData
}

/**
 * MemoryEntryData — the actual content stored in the MemoryVault.
 *
 * Includes the action type, which tool produced the input, and
 * action-specific data. The `toolId` field enables per-tool audit trails.
 */
export interface MemoryEntryData {
    /** What action the agent is taking/took */
    action: string
    /** Which tool's output drove this decision (or 'protocol' for protocol-level entries) */
    toolId: string
    /** Action-specific data (reasoning, scores, amounts, etc.) */
    [key: string]: unknown
}

// ═══════════════════════════════════════════════════════════════════════════
// Audit Types (for audit-reader workflow)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * AuditEntry — a single verified entry from the audit-reader workflow.
 */
export interface AuditEntry {
    /** S3 object key */
    key: string
    /** Action type (e.g., 'lp-entry', 'lp-entry-confirmed', 'scan') */
    type: string
    /** Which tool produced the input for this action */
    toolId: string
    /** When the action was recorded */
    timestamp: number
    /** Whether the S3 blob hash matches the on-chain commitment */
    verified: boolean
    /** When the on-chain commitment was made (block timestamp) */
    committedAt: number
    /** The full decrypted entry data */
    data: MemoryEntryData
}

/**
 * AuditLog — the complete response from the audit-reader workflow.
 */
export interface AuditLog {
    /** Which agent's log this is */
    agentId: string
    /** Chronologically ordered, verified decision log */
    decisionLog: AuditEntry[]
    /** Total number of entries */
    totalEntries: number
}
