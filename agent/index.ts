/**
 * Agent Service — Skills Engine
 *
 * Main loop:
 *  1. Load trader template
 *  2. For each tool in template.strategy.tools:
 *     - Fetch latest scan results via CRETrigger
 *     - Run Risk Analysis Skill: RawOpportunity -> ScoredOpportunity
 *     - Filter by thresholds
 *     - (Stub) Execute entries via ACEClient using LP sizing helper
 *
 * This file wires together higher-level orchestration but leaves
 * concrete ACE + CRE wiring as stubs to be filled in after T2.5.
 */

import { loadTemplate, type TraderTemplate } from './trader-template'
import { CRETrigger } from './cre-trigger'
import { ACEClient } from './ace-client'
import { calculatePositionAmount } from './lp-simulator'
import { scoreOpportunity, type RiskAnalysisDeps } from './skills/risk-analysis'
import { MemoryClient } from './memory-client'
import { cryptoNewsAlphaFetcher } from './alpha-fetcher'
import type {
    RawOpportunity,
    ScoredOpportunity,
    ToolResponse,
    ExitSignal,
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

async function runOnce(agentId: string) {
    const template = loadTemplate(agentId)

    const creTrigger = new CRETrigger({
        baseUrl: process.env.CRE_GATEWAY_URL || 'http://localhost:8080',
    })
    const ace = new ACEClient({
        apiUrl: process.env.ACE_API_URL || 'https://example-ace',
    })
    const memory = new MemoryClient()

    for (const toolId of template.strategy.tools) {
        const scanResults = await creTrigger.getScanResults(toolId)
        if (!scanResults || !scanResults.opportunities?.length) continue

        const scored = await scoreAll(riskDeps, scanResults, template)
        const qualified = filterByThresholds(scored, template)

        for (const opp of qualified) {
            await executeLpEntry(agentId, memory, ace, template, opp)
        }

        // After evaluating new entries, inspect monitor results for this tool
        // and act on any exit signals the template is configured to honor.
        await handleMonitorSignals(agentId, memory, ace, template, toolId, creTrigger)
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

async function handleMonitorSignals(
    agentId: string,
    memory: MemoryClient,
    ace: ACEClient,
    template: TraderTemplate,
    toolId: string,
    creTrigger: CRETrigger
): Promise<void> {
    const monitorResults = await creTrigger.getMonitorResults(toolId)
    if (!monitorResults || !monitorResults.exitSignals?.length) {
        return
    }

    const actionable = filterExitSignals(monitorResults.exitSignals, template)
    if (!actionable.length) {
        return
    }

    for (const signal of actionable) {
        await executeLpExit(agentId, memory, ace, template, toolId, signal)
    }
}

async function executeLpEntry(
    agentId: string,
    memory: MemoryClient,
    ace: ACEClient,
    template: TraderTemplate,
    opportunity: ScoredOpportunity
): Promise<void> {
    // In a real implementation we’d read wallet balance from ACE or chain.
    const fakeBalance = 1_000_000_000n // stubbed
    const amount = calculatePositionAmount(template, fakeBalance)
    if (amount <= 0n) {
        console.log('[Agent] Skipping LP entry, calculated amount is zero')
        return
    }

    console.log('[Agent] Executing LP entry (stub):', {
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

    await ace.privateTransfer({
        recipient: process.env.LP_POSITION_SHIELDED_ADDRESS || '0xLP_SHIELDED',
        token: process.env.TOKEN_ADDRESS || '0xTOKEN',
        amount,
    })

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

async function executeLpExit(
    agentId: string,
    memory: MemoryClient,
    ace: ACEClient,
    template: TraderTemplate,
    toolId: string,
    signal: ExitSignal
): Promise<void> {
    // For the MVP we use a stubbed position size. In a full implementation,
    // this would be derived from on-chain or ACE position state.
    const fakePositionSize = 500_000_000n

    console.log('[Agent] Executing LP exit (stub):', {
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

    await ace.privateTransfer({
        recipient: process.env.HOLD_WALLET_SHIELDED_ADDRESS || '0xHOLD_SHIELDED',
        token: process.env.TOKEN_ADDRESS || '0xTOKEN',
        amount: fakePositionSize,
    })

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

async function main() {
    const agentId = process.env.AGENT_ID || 'agent-alpha-01'
    await runOnce(agentId)
}

main().catch(err => {
    console.error('[Agent] Fatal error:', err)
    process.exit(1)
})

