import { cryptoNewsAlphaFetcher } from './agent/alpha-fetcher.ts'
import { scoreOpportunity } from './agent/skills/risk-analysis.ts'

const opp = {
    toolId: 'uniswap-v3-lp',
    assetId: '0xpool-link-weth',
    entryParams: {
        pool: {
            token0: { symbol: 'LINK' },
            token1: { symbol: 'WETH' },
            feeTier: 3000,
            totalValueLockedUSD: '820000',
        },
    },
}

const template: any = {
    agentId: 'agent-alpha-01',
    strategy: { type: 'clmm_lp', tools: ['uniswap-v3-lp'] },
    customInstructions: 'Conservative CLMM LP. Reject bearish news dominance.',
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY_VAR
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`

const deps: any = {
    alphaFetcher: cryptoNewsAlphaFetcher,
    gemini: {
        async generateJson(args: { systemPrompt: string; input: unknown }) {
            const resp = await fetch(GEMINI_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: args.systemPrompt }] },
                    contents: [{ parts: [{ text: JSON.stringify(args.input) }] }],
                    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
                }),
            })
            const json = await resp.json() as any
            if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${JSON.stringify(json.error)}`)
            return JSON.parse(json.candidates[0].content.parts[0].text)
        },
    },
}

console.log('Fetching real alpha + scoring with gemini-2.5-flash...')
const scored = await scoreOpportunity(deps, opp, template)
console.log(JSON.stringify({
    opportunityScore: scored.opportunityScore,
    trustScore: scored.trustScore,
    riskLevel: scored.riskLevel,
    reasoning: scored.reasoning,
}, null, 2))
