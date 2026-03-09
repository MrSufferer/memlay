/**
 * Risk Analysis Skill — Tool-Agnostic Scoring
 *
 * Takes RawOpportunity objects from any tool and produces ScoredOpportunity
 * by combining:
 *  - public CLMM/tool data from entryParams
 *  - private alpha/news signals fetched via ConfidentialHTTPClient
 *  - trader's customInstructions from the TraderTemplate
 *
 * This skill runs in the agent service (Node.js/Bun), NOT in a CRE workflow.
 * It uses the regular HTTP client to talk to Gemini and assumes alpha/news
 * fetching happens inside the agent or via a separate service.
 */

import type {
    RawOpportunity,
    ScoredOpportunity,
} from '../../cre-memoryvault/protocol/tool-interface'
import type { TraderTemplate } from '../trader-template'

export interface AlphaSignal {
    sourceId: string
    summary: string
    sentiment?: 'bullish' | 'bearish' | 'neutral'
}

export interface AlphaFetcher {
    /**
     * Fetch alpha/news signals for a given opportunity and trader template.
     * Implementation is pluggable; could call a CRE workflow, a news API,
     * or a local cache.
     */
    fetchAlpha(
        opportunity: RawOpportunity,
        template: TraderTemplate
    ): Promise<AlphaSignal[]>
}

export interface GeminiClient {
    /**
     * Call Gemini with a system prompt and JSON input, returning parsed JSON.
     * This keeps the Risk Analysis Skill decoupled from HTTP details.
     */
    generateJson<T>(args: {
        systemPrompt: string
        input: unknown
    }): Promise<T>
}

export interface RiskAnalysisDeps {
    alphaFetcher: AlphaFetcher
    gemini: GeminiClient
}

export interface GeminiRiskResponse {
    opportunityScore: number
    trustScore: number
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'SCAM'
    reasoning: string
}

/**
 * scoreOpportunity — core entrypoint for the Risk Analysis Skill.
 *
 * Tool-agnostic: it only assumes that opportunity.entryParams contains
 * tool-specific data and that alphaFetcher knows how to enrich it.
 */
export async function scoreOpportunity(
    deps: RiskAnalysisDeps,
    opportunity: RawOpportunity,
    template: TraderTemplate
): Promise<ScoredOpportunity> {
    const { alphaFetcher, gemini } = deps

    // 1) Fetch private alpha/news signals for this opportunity
    const alphaSignals = await alphaFetcher.fetchAlpha(opportunity, template)

    // 2) Build Gemini system prompt with trader instructions + strategy
    const systemPrompt = [
        'You are a DeFi risk and opportunity scoring engine for CLMM and related strategies.',
        'You receive:',
        '- Raw opportunity data from a tool (pool statistics, trust signals, etc.).',
        '- Private alpha/news signals configured by the trader.',
        '',
        'You must:',
        '- Produce numeric opportunityScore (0-100) and trustScore (0-100).',
        "- Classify riskLevel as one of: LOW, MEDIUM, HIGH, SCAM.",
        '- Explain the reasoning in 1-2 concise paragraphs.',
        '',
        `Trader strategy type: ${template.strategy.type}`,
        template.customInstructions
            ? `Trader custom instructions: ${template.customInstructions}`
            : '',
        '',
        'Return ONLY valid JSON with fields: opportunityScore, trustScore, riskLevel, reasoning.',
    ]
        .filter(Boolean)
        .join('\n')

    // 3) Prepare model input combining public + private data
    const modelInput = {
        toolId: opportunity.toolId,
        assetId: opportunity.assetId,
        entryParams: opportunity.entryParams,
        alphaSignals,
    }

    // 4) Call Gemini via injected client
    const scored = await gemini.generateJson<GeminiRiskResponse>({
        systemPrompt,
        input: modelInput,
    })

    // 5) Map model output into ScoredOpportunity
    return {
        ...opportunity,
        opportunityScore: scored.opportunityScore,
        trustScore: scored.trustScore,
        riskLevel: scored.riskLevel,
        reasoning: scored.reasoning,
    }
}

