/**
 * MemoryVault Agent Protocol — Trader Template System
 *
 * Configures per-trader agent behavior: which tools to use, risk parameters,
 * entry/exit thresholds, and custom instructions injected into the LLM prompt.
 *
 * Templates are stored as JSON files under agent/templates/{agentId}.json.
 * The agent loads a template at startup and drives its entire decision loop
 * from it — which tools to scan, what thresholds to apply, how to size positions.
 *
 * KEY DESIGN PRINCIPLES:
 * 1. Templates are the ONLY per-trader config source. No env vars, no hardcoded values.
 * 2. `strategy.tools` drives tool iteration — adding a tool = adding its toolId here.
 * 3. `customInstructions` injects trader personality into the Gemini LLM prompt (T2.3).
 * 4. S3 helpers allow remote template storage for multi-agent setups (optional).
 *
 * @module agent/trader-template
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ═══════════════════════════════════════════════════════════════════════════
// Imports from Protocol Layer
// ═══════════════════════════════════════════════════════════════════════════

import type { RiskLevel } from '../cre-memoryvault/protocol/tool-interface'

// ═══════════════════════════════════════════════════════════════════════════
// Alpha Source Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single alpha/news source configured by the trader.
 *
 * The `secretEnvVar` field names the environment variable (with `_VAR` suffix)
 * that holds the API key for this source. In a CRE workflow context this maps
 * to a CRE vault secret. In the agent service it maps to `process.env[secretEnvVar]`.
 *
 * @example
 * {
 *   id: 'crypto-news51',
 *   description: '24h crypto news via RapidAPI',
 *   secretEnvVar: 'RAPIDAPI_KEY_VAR',
 * }
 */
export interface AlphaSource {
    /** Unique identifier for the source — used for logging and deduplication */
    id: string

    /** Human-readable description shown in logs and LLM context */
    description: string

    /**
     * Environment variable name whose value is the API key for this source.
     * Must end with `_VAR` (CRE secret naming convention).
     * @example 'RAPIDAPI_KEY_VAR'
     */
    secretEnvVar: string

    /**
     * Optional base URL override. If not set, the fetcher uses its own default.
     * Allows traders to point to a custom endpoint (e.g., a self-hosted news proxy).
     */
    baseUrl?: string
}

/**
 * Alpha source configuration block for a trader template.
 * Drives which news/data feeds the Risk Analysis Skill queries
 * for each `RawOpportunity`.
 */
export interface AlphaConfig {
    /**
     * Ordered list of alpha sources to query.
     * Each source is consulted in order; combined signals are fed to Gemini.
     * Empty array = no alpha signals (Gemini scores on public data only).
     */
    sources: AlphaSource[]
}

// ═══════════════════════════════════════════════════════════════════════════
// TraderTemplate Interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * TraderTemplate — the top-level config object that drives agent behavior.
 *
 * Loaded at agent startup. Drives the main loop iteration over tools,
 * opportunity filtering thresholds, position sizing, and LLM prompt content.
 *
 * Stored as JSON in agent/templates/{agentId}.json.
 *
 * @example
 * const template = loadTemplate('agent-alpha-01')
 * for (const toolId of template.strategy.tools) {
 *   const results = await getToolScanResults(toolId)
 *   // ... score, filter, execute
 * }
 */
export interface TraderTemplate {
    /** Unique agent identifier — must match agentId used in MemoryVault entries */
    agentId: string

    /** Human-readable name for display and logging */
    name: string

    /** Template version — increment when making breaking changes */
    version: string

    /** Trading strategy configuration */
    strategy: TraderStrategy

    /** Position sizing and risk limits */
    risk: RiskConfig

    /**
     * Free-form instructions injected directly into the Gemini LLM system prompt
     * by the Risk Analysis Skill (T2.3). Lets traders personalize scoring without
     * code changes.
     *
     * @example
     * "I prefer established tokens with >$1M TVL. Only enter if trust score > 90.
     *  Avoid anything less than 7 days old. Conservative approach only."
     */
    customInstructions: string

    /**
     * Alpha/news source configuration.
     *
     * Drives which feeds the Risk Analysis Skill queries for each opportunity.
     * If omitted, the skill falls back to the default provider configured
     * via `RAPIDAPI_KEY_VAR` in the environment.
     *
     * @example
     * alpha: {
     *   sources: [
     *     { id: 'crypto-news51', description: '24h crypto news', secretEnvVar: 'RAPIDAPI_KEY_VAR' }
     *   ]
     * }
     */
    alpha?: AlphaConfig

    /** ISO 8601 timestamp of when this template was created */
    createdAt: string

    /** ISO 8601 timestamp of last update */
    updatedAt: string
}

// ─── Strategy ───────────────────────────────────────────────────────────────

/**
 * All supported strategy types for this MVP.
 *
 * | Type           | Behavior                                                |
 * |----------------|---------------------------------------------------------|
 * | clmm_lp        | Enter concentrated LP → collect fees → exit on triggers |
 * | snipe_and_exit | High-risk CLMM: enter early → quick 2-5x → exit fast    |
 * | custom         | Use customInstructions exclusively (no preset behavior) |
 *
 * Note: `hold_til_dump` is reserved as a potential future, non-CLMM strategy
 * and is intentionally excluded from this implementation's StrategyType.
 */
export type StrategyType = 'clmm_lp' | 'snipe_and_exit' | 'custom'

/**
 * Trading strategy configuration.
 *
 * `tools` is the central extensibility point — each entry is a toolId that
 * must have a corresponding entry in the ToolRegistry. Adding Aave = add
 * 'aave-lending' here + create the CRE workflow. Agent code doesn't change.
 */
export interface TraderStrategy {
    /** Strategy type — drives execution path in the agent's main loop */
    type: StrategyType

    /**
     * Ordered list of tool IDs to iterate during scan phase.
     * Each must match a ToolRegistration.toolId in the ToolRegistry.
     * @example ['uniswap-v3-lp', 'aave-lending']
     */
    tools: string[]

    /** Thresholds for filtering ScoredOpportunity[] (output of Risk Analysis Skill) */
    entryThresholds: EntryThresholds

    /**
     * Which ExitSignal trigger names to act on.
     * The monitor workflow returns ALL fired signals; the agent only acts
     * on triggers listed here. Unrecognized triggers are logged but ignored.
     * @example ['apy_drop', 'whale_accumulation', 'tvl_crash', 'profit_target']
     */
    exitTriggers: string[]
}

/**
 * Scoring thresholds applied by the agent's Decision Skill after Risk Analysis.
 * Opportunities below any threshold are logged and discarded.
 */
export interface EntryThresholds {
    /**
     * Minimum opportunity quality score (0-100).
     * Set higher for safer, less frequent entries.
     */
    minOpportunityScore: number

    /**
     * Minimum trust/safety score (0-100).
     * Scores below this indicate suspicious or unverified assets.
     */
    minTrustScore: number

    /**
     * Maximum acceptable risk level.
     * SCAM-classified opportunities are always rejected regardless of this.
     * 'LOW' = only enter very safe pools; 'MEDIUM' = moderate risk ok.
     */
    maxRiskLevel: Extract<RiskLevel, 'LOW' | 'MEDIUM'>
}

// ─── Risk Config ─────────────────────────────────────────────────────────────

/**
 * Position sizing and risk management configuration.
 *
 * All monetary values are expressed as percentages or multipliers,
 * not absolute amounts, so the template is wallet-size agnostic.
 */
export interface RiskConfig {
    /**
     * Maximum fraction of total wallet balance to allocate per position (0–1).
     * @example 0.1 = never put more than 10% of balance in one position
     */
    maxPositionPct: number

    /** Whether to enable automatic stop-loss exits */
    stopLossEnabled: boolean

    /**
     * Percentage drop from entry price that triggers stop-loss exit.
     * Only used when stopLossEnabled = true.
     * @example 0.15 = exit if position value drops 15% from entry
     */
    stopLossDropPct: number

    /**
     * Profit multiplier target that triggers a take-profit exit.
     * @example 2.0 = exit when position value doubles (2x return)
     */
    profitTarget: number

    /**
     * Maximum number of concurrent open positions across all tools.
     * Prevents overexposure when multiple tools find simultaneous opportunities.
     */
    maxConcurrentPositions: number
}

// ═══════════════════════════════════════════════════════════════════════════
// Template Loading & Saving (Local Filesystem)
// ═══════════════════════════════════════════════════════════════════════════

/** Default directory containing template JSON files (relative to this file) */
const TEMPLATES_DIR = join(import.meta.dir, 'templates')

/**
 * Load a trader template from disk.
 *
 * Lookup order:
 * 1. `agent/templates/{agentId}.json` — agent-specific template
 * 2. `agent/templates/{strategyType}.json` — strategy-type default (fallback)
 *
 * Throws if neither file exists. The caller (agent main loop) must handle this
 * as a fatal startup error.
 *
 * @param agentId - Unique agent identifier
 * @returns Parsed and validated TraderTemplate
 * @throws Error if template file not found or invalid JSON
 *
 * @example
 * const template = loadTemplate('agent-alpha-01')
 * console.log(template.strategy.tools) // ['uniswap-v3-lp']
 */
export function loadTemplate(agentId: string): TraderTemplate {
    const agentPath = join(TEMPLATES_DIR, `${agentId}.json`)
    const defaultPath = join(TEMPLATES_DIR, 'clmm_lp.json')

    let templatePath: string

    if (existsSync(agentPath)) {
        templatePath = agentPath
    } else if (existsSync(defaultPath)) {
        console.warn(
            `[trader-template] No template for agent '${agentId}', using default clmm_lp.json`
        )
        templatePath = defaultPath
    } else {
        throw new Error(
            `[trader-template] No template found for agent '${agentId}' ` +
            `and no default template at ${defaultPath}. ` +
            `Create agent/templates/${agentId}.json or agent/templates/clmm_lp.json.`
        )
    }

    const raw = readFileSync(templatePath, 'utf-8')

    let template: TraderTemplate
    try {
        template = JSON.parse(raw) as TraderTemplate
    } catch (e) {
        throw new Error(
            `[trader-template] Invalid JSON in template file ${templatePath}: ${e}`
        )
    }

    validateTemplate(template)
    return template
}

/**
 * Save a trader template to disk (agent/templates/{agentId}.json).
 *
 * Sets updatedAt to current time before writing.
 * Used by the agent service to persist template mutations (e.g., after
 * learning from outcomes or user configuration changes).
 *
 * @param template - The template to save (agentId used as filename)
 */
export function saveTemplate(template: TraderTemplate): void {
    const templatePath = join(TEMPLATES_DIR, `${template.agentId}.json`)
    const updated: TraderTemplate = {
        ...template,
        updatedAt: new Date().toISOString(),
    }
    writeFileSync(templatePath, JSON.stringify(updated, null, 2), 'utf-8')
    console.log(`[trader-template] Saved template to ${templatePath}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// Template Validation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate a TraderTemplate for required fields and sensible values.
 * Throws descriptively on first validation failure.
 *
 * Called automatically by loadTemplate() and loadTemplateFromS3().
 */
function validateTemplate(t: TraderTemplate): void {
    if (!t.agentId) throw new Error('[trader-template] Template missing agentId')
    if (!t.strategy) throw new Error('[trader-template] Template missing strategy')
    if (!Array.isArray(t.strategy.tools) || t.strategy.tools.length === 0) {
        throw new Error('[trader-template] strategy.tools must be a non-empty array')
    }
    if (!t.strategy.entryThresholds) {
        throw new Error('[trader-template] Template missing strategy.entryThresholds')
    }
    if (t.strategy.entryThresholds.minOpportunityScore < 0 || t.strategy.entryThresholds.minOpportunityScore > 100) {
        throw new Error('[trader-template] minOpportunityScore must be 0-100')
    }
    if (t.strategy.entryThresholds.minTrustScore < 0 || t.strategy.entryThresholds.minTrustScore > 100) {
        throw new Error('[trader-template] minTrustScore must be 0-100')
    }
    if (!t.risk) throw new Error('[trader-template] Template missing risk config')
    if (t.risk.maxPositionPct <= 0 || t.risk.maxPositionPct > 1) {
        throw new Error('[trader-template] maxPositionPct must be between 0 and 1 (exclusive)')
    }
    if (t.risk.maxConcurrentPositions < 1) {
        throw new Error('[trader-template] maxConcurrentPositions must be >= 1')
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// S3 Template Storage Helpers (Optional — Multi-Agent Remote Config)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * AWS credentials for S3 operations.
 * Sourced from env vars or CRE secret store depending on context.
 */
export interface AWSCredentials {
    accessKeyId: string
    secretAccessKey: string
    region: string
    bucket: string
}

/**
 * Load a TraderTemplate from S3.
 *
 * Fetches `templates/{agentId}.json` from the configured S3 bucket.
 * Used by the agent service when operating in multi-agent mode where
 * templates are managed centrally rather than per-machine.
 *
 * Falls back to local filesystem if S3 fetch fails (non-fatal degradation).
 *
 * @param agentId - Unique agent identifier
 * @param creds - AWS credentials for S3 access
 * @returns Parsed and validated TraderTemplate from S3
 * @throws Error if S3 fetch fails AND no local fallback exists
 */
export async function loadTemplateFromS3(
    agentId: string,
    creds: AWSCredentials
): Promise<TraderTemplate> {
    const s3Key = `templates/${agentId}.json`
    const url = `https://${creds.bucket}.s3.${creds.region}.amazonaws.com/${s3Key}`

    let response: Response
    try {
        response = await fetch(url, {
            headers: await s3GetHeaders(creds, s3Key),
        })
    } catch (e) {
        console.warn(`[trader-template] S3 fetch failed for ${agentId}, falling back to local: ${e}`)
        return loadTemplate(agentId)
    }

    if (!response.ok) {
        if (response.status === 404) {
            console.warn(`[trader-template] Template not found in S3 for ${agentId}, falling back to local`)
            return loadTemplate(agentId)
        }
        throw new Error(`[trader-template] S3 GET failed: ${response.status} ${response.statusText}`)
    }

    const raw = await response.text()
    const template = JSON.parse(raw) as TraderTemplate
    validateTemplate(template)
    return template
}

/**
 * Save a TraderTemplate to S3.
 *
 * Writes `templates/{agentId}.json` to the configured S3 bucket.
 * Used when the agent service needs to persist template updates centrally.
 *
 * Note: S3 writes use presigned URLs in production; raw SigV4 signing
 * in this helper is equivalent to the pattern used in memory-writer.ts.
 *
 * @param template - Template to persist
 * @param creds - AWS credentials
 */
export async function saveTemplateToS3(
    template: TraderTemplate,
    creds: AWSCredentials
): Promise<void> {
    const s3Key = `templates/${template.agentId}.json`
    const url = `https://${creds.bucket}.s3.${creds.region}.amazonaws.com/${s3Key}`
    const body = JSON.stringify({ ...template, updatedAt: new Date().toISOString() }, null, 2)

    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            ...(await s3PutHeaders(creds, s3Key, body)),
        },
        body,
    })

    if (!response.ok) {
        throw new Error(`[trader-template] S3 PUT failed: ${response.status} ${response.statusText}`)
    }

    console.log(`[trader-template] Template saved to s3://${creds.bucket}/${s3Key}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// SigV4 Signing Helpers (minimal — for S3 template storage)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build Authorization headers for an S3 GET request.
 * Implements a minimal AWS SigV4 signing flow without external dependencies.
 *
 * NOTE: In CRE WASM workflows, use the pattern from memory-writer.ts (HTTPClient
 * with inline SigV4). These helpers are for use in the Node.js/Bun agent service
 * (agent/index.ts) where the Web Crypto API IS available.
 */
async function s3GetHeaders(
    creds: AWSCredentials,
    s3Key: string
): Promise<Record<string, string>> {
    const now = new Date()
    const amzDate = formatAmzDate(now)
    const dateStamp = amzDate.slice(0, 8)
    const service = 's3'
    const host = `${creds.bucket}.s3.${creds.region}.amazonaws.com`

    const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`
    const signedHeaders = 'host;x-amz-date'
    const payloadHash = await sha256Hex('')

    const canonicalRequest = [
        'GET',
        `/${s3Key}`,
        '',
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n')

    const credentialScope = `${dateStamp}/${creds.region}/${service}/aws4_request`
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        await sha256Hex(canonicalRequest),
    ].join('\n')

    const signingKey = await getSigningKey(creds.secretAccessKey, dateStamp, creds.region, service)
    const signature = await hmacHex(signingKey, stringToSign)

    return {
        Host: host,
        'X-Amz-Date': amzDate,
        Authorization:
            `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    }
}

/**
 * Build Authorization headers for an S3 PUT request.
 */
async function s3PutHeaders(
    creds: AWSCredentials,
    s3Key: string,
    body: string
): Promise<Record<string, string>> {
    const now = new Date()
    const amzDate = formatAmzDate(now)
    const dateStamp = amzDate.slice(0, 8)
    const service = 's3'
    const host = `${creds.bucket}.s3.${creds.region}.amazonaws.com`

    const payloadHash = await sha256Hex(body)
    const canonicalHeaders =
        `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date'

    const canonicalRequest = [
        'PUT',
        `/${s3Key}`,
        '',
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n')

    const credentialScope = `${dateStamp}/${creds.region}/${service}/aws4_request`
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        await sha256Hex(canonicalRequest),
    ].join('\n')

    const signingKey = await getSigningKey(creds.secretAccessKey, dateStamp, creds.region, service)
    const signature = await hmacHex(signingKey, stringToSign)

    return {
        'X-Amz-Content-Sha256': payloadHash,
        'X-Amz-Date': amzDate,
        Authorization:
            `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    }
}

// ─── SigV4 Crypto Primitives (Web Crypto API — Bun/Node.js agent only) ──────

async function sha256Hex(data: string): Promise<string> {
    const encoded = new TextEncoder().encode(data)
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
}

async function hmacHex(key: CryptoKey, data: string): Promise<string> {
    const encoded = new TextEncoder().encode(data)
    const sig = await crypto.subtle.sign('HMAC', key, encoded)
    return Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
}

async function hmacKey(key: CryptoKey | string, data: string): Promise<CryptoKey> {
    const keyMaterial =
        typeof key === 'string'
            ? new TextEncoder().encode(key)
            : new Uint8Array(
                await crypto.subtle.exportKey('raw', key)
            )
    const importedKey = await crypto.subtle.importKey(
        'raw', keyMaterial, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    )
    const encoded = new TextEncoder().encode(data)
    const sig = await crypto.subtle.sign('HMAC', importedKey, encoded)
    return crypto.subtle.importKey(
        'raw', sig, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    )
}

async function getSigningKey(
    secretKey: string,
    dateStamp: string,
    region: string,
    service: string
): Promise<CryptoKey> {
    const kDate = await hmacKey(`AWS4${secretKey}`, dateStamp)
    const kRegion = await hmacKey(kDate, region)
    const kService = await hmacKey(kRegion, service)
    return hmacKey(kService, 'aws4_request')
}

function formatAmzDate(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}
