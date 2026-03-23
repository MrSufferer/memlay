/**
 * Agent Service — Skills Engine
 *
 * Main loop:
 *  1. Load trader template
 *  2. For each tool in template.strategy.tools:
 *     - Fetch latest scan results via the target backend
 *     - Run Risk Analysis Skill: RawOpportunity -> ScoredOpportunity
 *     - Filter by thresholds
 *     - Execute entries via the active execution backend using LP sizing helper
 *
 * This file wires together higher-level orchestration but leaves
 * target-specific wiring behind chain-agnostic runtime interfaces.
 */

import { loadTemplate, type TraderTemplate } from './trader-template'
import { calculatePositionAmount } from './lp-simulator'
import { scoreOpportunity, type RiskAnalysisDeps } from './skills/risk-analysis'
import { cryptoNewsAlphaFetcher } from './alpha-fetcher'
import { loadDeploymentTargetConfig } from './deploy-runtime-config'
import type {
    AgentBackend,
    AgentExecutionRuntime,
    AgentMemoryRuntime,
    AgentToolRuntime,
} from './core/backend'
import { createAgentBackend } from './core/backend-factory'
import {
    buildBonzoEnterRequest,
    buildBonzoExitRequest,
} from './tools/bonzo-vaults/execution'
import type {
    ScoredOpportunity,
    ExitSignal,
    ToolRequest,
    ToolResponse,
} from '../cre-memoryvault/protocol/tool-interface'

// ── Real RiskAnalysisDeps ────────────────────────────────────────────────────
// alphaFetcher: crypto-news51 via RapidAPI (RAPIDAPI_KEY_VAR in .env)
// gemini:       Gemini 2.0 Flash (GEMINI_API_KEY_VAR in .env)

const GEMINI_API_KEY = process.env.GEMINI_API_KEY_VAR
const GEMINI_URL =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`

const riskDeps: RiskAnalysisDeps = {
    alphaFetcher: cryptoNewsAlphaFetcher,

    gemini: {
        async generateJson<T>(args: { systemPrompt: string; input: unknown }): Promise<T> {
            if (!GEMINI_API_KEY || GEMINI_API_KEY === 'dummy-gemini-key') {
                // Fallback: deterministic scoring so the demo still works without a key
                console.warn('[Gemini] No API key — using deterministic stub scoring')
                const input: any = args.input ?? {}
                const pool = input.entryParams?.pool ?? input.entryParams
                const pair: string = pool?.pair ?? pool?.token0?.symbol ?? ''
                const isScam = pair.toUpperCase().includes('SCAM')
                return (isScam
                    ? {
                        opportunityScore: 10, trustScore: 5, riskLevel: 'SCAM',
                        reasoning: 'Stub: token name contains SCAM.'
                    }
                    : {
                        opportunityScore: 82, trustScore: 85, riskLevel: 'MEDIUM',
                        reasoning: 'Stub: non-scam pool with moderate risk profile.'
                    }
                ) as T
            }

            // Retry up to 3× with exponential backoff on 429 rate-limit
            const MAX_ATTEMPTS = 3
            let attempt = 0
            let resp: Response
            while (true) {
                attempt++
                resp = await fetch(GEMINI_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        systemInstruction: { parts: [{ text: args.systemPrompt }] },
                        contents: [{ parts: [{ text: JSON.stringify(args.input) }] }],
                        generationConfig: {
                            responseMimeType: 'application/json',
                            temperature: 0,
                        },
                    }),
                })

                if (resp.status === 429 && attempt < MAX_ATTEMPTS) {
                    const waitMs = attempt * 2000
                    console.warn(`[Gemini] Rate limited (429) — retrying in ${waitMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`)
                    await new Promise(r => setTimeout(r, waitMs))
                    continue
                }
                break
            }

            if (!resp!.ok) {
                const err = await resp!.text()
                // On rate limit after retries, fall back to stub so the agent doesn't crash
                if (resp!.status === 429) {
                    console.warn('[Gemini] Quota exhausted — falling back to deterministic stub scoring')
                    const input: any = args.input ?? {}
                    const pool = input.entryParams?.pool ?? input.entryParams
                    const pair: string = pool?.pair ?? pool?.token0?.symbol ?? ''
                    const tvl: number = Number(pool?.tvlUSD ?? pool?.tvl ?? 0)
                    const isScam = pair.toUpperCase().includes('SCAM')
                    const isWellKnown = /WETH|USDC|USDT|WBTC|DAI|ETH/i.test(pair)
                    return (isScam
                        ? { opportunityScore: 5, trustScore: 5, riskLevel: 'SCAM', reasoning: 'Stub: SCAM token name.' }
                        : isWellKnown && tvl > 1_000_000
                            ? { opportunityScore: 85, trustScore: 88, riskLevel: 'MEDIUM', reasoning: 'Stub: well-known pair, high TVL.' }
                            : { opportunityScore: 55, trustScore: 50, riskLevel: 'HIGH', reasoning: 'Stub: unknown pair, insufficient data.' }
                    ) as T
                }
                throw new Error(`Gemini API error ${resp!.status}: ${err.slice(0, 200)}`)
            }

            const json = await resp.json() as any
            let text: string = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}'
            text = text.replace(/```json|```/g, '').trim()
            return JSON.parse(text) as T
        },
    },
}

export async function runOnce(
    agentId: string,
    backend: AgentBackend,
    options: {
        template?: TraderTemplate
        riskDeps?: RiskAnalysisDeps
    } = {}
) {
    const template = options.template ?? loadTemplate(agentId)
    const deps = options.riskDeps ?? riskDeps

    for (const toolId of template.strategy.tools) {
        const exitExecuted = await handleMonitorSignals(
            agentId,
            backend.memory,
            backend.execution,
            template,
            toolId,
            backend.tools
        )
        if (exitExecuted) {
            continue
        }

        const scanResults = await backend.tools.scan(toolId)

        if (scanResults?.opportunities?.length) {
            const scored = await scoreAll(deps, scanResults, template)
            const qualified = filterByThresholds(scored, template)

            for (const opp of qualified) {
                await executeLpEntry(agentId, backend.memory, backend.execution, template, opp)
            }
        }
    }
}

async function scoreAll(
    deps: RiskAnalysisDeps,
    scanResults: ToolResponse,
    template: TraderTemplate
): Promise<ScoredOpportunity[]> {
    const raw = scanResults.opportunities ?? []
    // Cap at 5 to keep demo runs fast — subgraph returns up to 50 pools
    const topN = raw.slice(0, 5)
    const scored: ScoredOpportunity[] = []
    for (const opp of topN) {
        const s = await scoreOpportunity(deps, opp, template)
        scored.push(s)
        // 1s pause between pools to stay within Gemini free-tier rate limits
        if (topN.indexOf(opp) < topN.length - 1) {
            await new Promise(r => setTimeout(r, 1000))
        }
    }
    return scored
}

function filterByThresholds(
    scored: ScoredOpportunity[],
    template: TraderTemplate
): ScoredOpportunity[] {
    const t = template.strategy.entryThresholds
    return scored.filter(opp => {
        const okOpp = opp.opportunityScore >= t.minOpportunityScore
        const okTrust = opp.trustScore >= t.minTrustScore
        const okRisk =
            (t.maxRiskLevel === 'LOW' && opp.riskLevel === 'LOW') ||
            (t.maxRiskLevel === 'MEDIUM' &&
                (opp.riskLevel === 'LOW' || opp.riskLevel === 'MEDIUM'))
        const notScam = opp.riskLevel !== 'SCAM'

        if (!notScam) {
            console.log('[Agent] Rejecting opportunity as SCAM:', {
                toolId: opp.toolId,
                assetId: opp.assetId,
                opportunityScore: opp.opportunityScore,
                trustScore: opp.trustScore,
                riskLevel: opp.riskLevel,
            })
        }

        return okOpp && okTrust && okRisk && notScam
    })
}

function filterExitSignals(
    signals: ExitSignal[],
    template: TraderTemplate
): ExitSignal[] {
    const allowed = new Set(template.strategy.exitTriggers ?? [])
    return signals.filter(signal => allowed.has(signal.trigger))
}

function buildEnterToolRequest(args: {
    agentId: string
    template: TraderTemplate
    opportunity: ScoredOpportunity
    amount: bigint
}): ToolRequest {
    if (args.opportunity.toolId === 'bonzo-vaults') {
        return buildBonzoEnterRequest({
            agentId: args.agentId,
            strategyType: args.template.strategy.type,
            opportunity: args.opportunity,
            amount: args.amount,
            allocationPctBps: Math.round(args.template.risk.maxPositionPct * 10000),
        })
    }

    return {
        action: 'enter',
        agentId: args.agentId,
        strategyType: args.template.strategy.type,
        params: {
            assetId: args.opportunity.assetId,
            amountAtomic: args.amount.toString(),
            entryParams: args.opportunity.entryParams,
        },
    }
}

function buildExitToolRequest(args: {
    agentId: string
    template: TraderTemplate
    toolId: string
    signal: ExitSignal
    amount: bigint
}): ToolRequest {
    if (args.toolId === 'bonzo-vaults') {
        return buildBonzoExitRequest({
            agentId: args.agentId,
            strategyType: args.template.strategy.type,
            signal: args.signal,
        })
    }

    return {
        action: 'exit',
        agentId: args.agentId,
        strategyType: args.template.strategy.type,
        params: {
            amountAtomic: args.amount.toString(),
            trigger: args.signal.trigger,
            urgency: args.signal.urgency,
            data: args.signal.data,
        },
    }
}

async function handleMonitorSignals(
    agentId: string,
    memory: AgentMemoryRuntime,
    execution: AgentExecutionRuntime,
    template: TraderTemplate,
    toolId: string,
    tools: AgentToolRuntime
): Promise<boolean> {
    const monitorResults = await tools.monitor(toolId)
    if (!monitorResults || !monitorResults.exitSignals?.length) {
        return false
    }

    const actionable = filterExitSignals(monitorResults.exitSignals, template)
    if (!actionable.length) {
        return false
    }

    for (const signal of actionable) {
        await executeLpExit(agentId, memory, execution, template, toolId, signal)
    }

    return true
}

export async function executeLpEntry(
    agentId: string,
    memory: AgentMemoryRuntime,
    execution: AgentExecutionRuntime,
    template: TraderTemplate,
    opportunity: ScoredOpportunity
): Promise<void> {
    // In a real implementation we’d read wallet balance from chain state.
    const fakeBalance = 1_000_000_000n // stubbed
    const amount = calculatePositionAmount(template, fakeBalance)
    if (amount <= 0n) {
        console.log('[Agent] Skipping LP entry, calculated amount is zero')
        return
    }

    console.log('[Agent] Executing LP entry:', {
        toolId: opportunity.toolId,
        assetId: opportunity.assetId,
        amount: amount.toString(),
    })

    // Commit entry reasoning BEFORE executing (MemoryVault invariant)
    const entryKey = `lp-entry-${new Date().toISOString()}`
    await memory.commitEntry({
        agentId,
        entryKey,
        entryData: {
            action: 'lp-entry',
            toolId: opportunity.toolId,
            assetId: opportunity.assetId,
            opportunityScore: opportunity.opportunityScore,
            trustScore: opportunity.trustScore,
            riskLevel: opportunity.riskLevel,
            reasoning: opportunity.reasoning,
        } as any,
    })

    try {
        await execution.enterPosition({
            toolId: opportunity.toolId,
            request: buildEnterToolRequest({
                agentId,
                template,
                opportunity,
                amount,
            }),
        })
    } catch (error) {
        const failureKey = `lp-entry-failed-${new Date().toISOString()}`
        await memory.commitEntry({
            agentId,
            entryKey: failureKey,
            entryData: {
                action: 'lp-entry-failed',
                toolId: opportunity.toolId,
                assetId: opportunity.assetId,
                error: error instanceof Error ? error.message : String(error),
            } as any,
        })
        throw error
    }

    // Confirm entry AFTER execution
    const confirmKey = `lp-entry-confirmed-${new Date().toISOString()}`
    await memory.commitEntry({
        agentId,
        entryKey: confirmKey,
        entryData: {
            action: 'lp-entry-confirmed',
            toolId: opportunity.toolId,
            assetId: opportunity.assetId,
        } as any,
    })
}

export async function executeLpExit(
    agentId: string,
    memory: AgentMemoryRuntime,
    execution: AgentExecutionRuntime,
    template: TraderTemplate,
    toolId: string,
    signal: ExitSignal
): Promise<void> {
    // For the MVP we use a stubbed position size. In a full implementation,
    // this would be derived from on-chain position state.
    const fakePositionSize = 500_000_000n

    console.log('[Agent] Executing LP exit:', {
        toolId,
        trigger: signal.trigger,
        urgency: signal.urgency,
        amount: fakePositionSize.toString(),
    })

    // Commit exit reasoning BEFORE executing (MemoryVault invariant)
    const exitKey = `lp-exit-${new Date().toISOString()}`
    await memory.commitEntry({
        agentId,
        entryKey: exitKey,
        entryData: {
            action: 'lp-exit',
            toolId,
            trigger: signal.trigger,
            urgency: signal.urgency,
            data: signal.data,
        } as any,
    })

    try {
        await execution.exitPosition({
            toolId,
            request: buildExitToolRequest({
                agentId,
                template,
                toolId,
                signal,
                amount: fakePositionSize,
            }),
        })
    } catch (error) {
        const failureKey = `lp-exit-failed-${new Date().toISOString()}`
        await memory.commitEntry({
            agentId,
            entryKey: failureKey,
            entryData: {
                action: 'lp-exit-failed',
                toolId,
                trigger: signal.trigger,
                urgency: signal.urgency,
                error: error instanceof Error ? error.message : String(error),
            } as any,
        })
        throw error
    }

    // Confirm exit AFTER execution
    const confirmKey = `lp-exit-confirmed-${new Date().toISOString()}`
    await memory.commitEntry({
        agentId,
        entryKey: confirmKey,
        entryData: {
            action: 'lp-exit-confirmed',
            toolId,
            trigger: signal.trigger,
            urgency: signal.urgency,
        } as any,
    })
}

export async function main() {
    const defaultAgentId = loadDeploymentTargetConfig().id === 'hedera'
        ? 'agent-hedera-01'
        : 'agent-alpha-01'
    const agentId = process.env.AGENT_ID || defaultAgentId
    const backend = createAgentBackend()
    await runOnce(agentId, backend)
}

if (import.meta.main) {
    main().catch(err => {
        console.error('[Agent] Fatal error:', err)
        process.exit(1)
    })
}
