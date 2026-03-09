/**
 * MemoryVault Agent Protocol — Mock Data API
 *
 * Express server simulating DeFi data sources (DefiLlama, DEXTools, Token Sniffer, etc.)
 * Used by the Uniswap V3 LP Tool scanner during CRE workflow simulation.
 *
 * Endpoints:
 *   GET  /pools/clmm          → CLMM pool list (filterable by minTVL, maxAgeDays)
 *   GET  /trust/:token        → Trust signals for a token
 *   POST /pools/simulate      → Inject custom pool/trust scenarios for demo
 *   GET  /health              → Health check
 *
 * Auth: x-api-key header (matches DATA_API_KEY env var)
 * Port: 3001
 *
 * Start: bun run server/mock-data-api.ts
 */

import express from 'express'

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

interface Pool {
    id: string
    pair: string
    protocol: string
    token: string
    age: string
    tvl: number
    feeAPY: number
    feeTier: number
    tickSpacing: number
    currentTick: number
}

interface TrustSignals {
    tokenSniffer: { score: number; honeypot: boolean; rugPull: boolean }
    etherscan: { verified: boolean; ownerRenounced: boolean; proxy: boolean }
    uncx: { liquidityLocked: boolean; lockDuration: string; lockPct: number }
    holders: { top10Pct: number; totalHolders: number }
}

// ═══════════════════════════════════════════════════════════════════════════
// Pre-seeded Data
// ═══════════════════════════════════════════════════════════════════════════

const pools: Pool[] = [
    {
        id: 'pool-weth-alpha',
        pair: 'WETH/ALPHA',
        protocol: 'uniswap-v3',
        token: '0xAlpha1234567890abcdef1234567890abcdef1234',
        age: '3d',
        tvl: 820_000,
        feeAPY: 240,
        feeTier: 3000,
        tickSpacing: 60,
        currentTick: 202100,
    },
    {
        id: 'pool-weth-scam',
        pair: 'WETH/SCAMTOKEN',
        protocol: 'uniswap-v3',
        token: '0xScam1234567890abcdef1234567890abcdef1234',
        age: '1d',
        tvl: 50_000,
        feeAPY: 9999,
        feeTier: 10000,
        tickSpacing: 200,
        currentTick: 100,
    },
    {
        id: 'pool-weth-good',
        pair: 'WETH/GOODTOKEN',
        protocol: 'uniswap-v3',
        token: '0xGood1234567890abcdef1234567890abcdef1234',
        age: '5d',
        tvl: 1_200_000,
        feeAPY: 180,
        feeTier: 3000,
        tickSpacing: 60,
        currentTick: 195000,
    },
]

const trustData: Record<string, TrustSignals> = {
    '0xAlpha1234567890abcdef1234567890abcdef1234': {
        tokenSniffer: { score: 92, honeypot: false, rugPull: false },
        etherscan: { verified: true, ownerRenounced: true, proxy: false },
        uncx: { liquidityLocked: true, lockDuration: '12 months', lockPct: 95 },
        holders: { top10Pct: 28, totalHolders: 1420 },
    },
    '0xScam1234567890abcdef1234567890abcdef1234': {
        tokenSniffer: { score: 15, honeypot: true, rugPull: true },
        etherscan: { verified: false, ownerRenounced: false, proxy: true },
        uncx: { liquidityLocked: false, lockDuration: '0', lockPct: 0 },
        holders: { top10Pct: 85, totalHolders: 42 },
    },
    '0xGood1234567890abcdef1234567890abcdef1234': {
        tokenSniffer: { score: 88, honeypot: false, rugPull: false },
        etherscan: { verified: true, ownerRenounced: true, proxy: false },
        uncx: { liquidityLocked: true, lockDuration: '18 months', lockPct: 90 },
        holders: { top10Pct: 22, totalHolders: 3200 },
    },
}

// ═══════════════════════════════════════════════════════════════════════════
// Express App
// ═══════════════════════════════════════════════════════════════════════════

const app = express()
app.use(express.json())

const API_KEY = process.env.DATA_API_KEY || 'demo-secret-key-12345'

// ── Auth middleware ──────────────────────────────────────────────────────

app.use((req, res, next) => {
    // Skip auth for health check
    if (req.path === '/health') return next()

    if (req.headers['x-api-key'] !== API_KEY) {
        return res.status(401).json({ error: 'Invalid API key' })
    }
    next()
})

// ── GET /pools/clmm ─────────────────────────────────────────────────────

app.get('/pools/clmm', (req, res) => {
    const minTVL = Number(req.query.minTVL) || 0
    const maxAgeDays = Number(req.query.maxAgeDays) || 7

    const filtered = pools.filter(p => {
        const ageDays = parseInt(p.age)
        return p.tvl >= minTVL && ageDays <= maxAgeDays
    })

    res.json({
        pools: filtered,
        totalPools: pools.length,
        filteredCount: filtered.length,
        filters: { minTVL, maxAgeDays },
        timestamp: Date.now(),
    })
})

// ── GET /trust/:token ───────────────────────────────────────────────────

app.get('/trust/:token', (req, res) => {
    const data = trustData[req.params.token]
    if (!data) {
        return res.status(404).json({
            token: req.params.token,
            error: 'Unknown token — no trust data available',
            timestamp: Date.now(),
        })
    }

    res.json({
        token: req.params.token,
        ...data,
        timestamp: Date.now(),
    })
})

// ── POST /pools/simulate ────────────────────────────────────────────────

app.post('/pools/simulate', (req, res) => {
    const { pool, trust } = req.body

    if (pool) {
        pools.push(pool as Pool)
    }
    if (trust?.token && trust?.data) {
        trustData[trust.token] = trust.data as TrustSignals
    }

    res.json({
        message: 'Simulation data updated',
        pools: pools.length,
        trustEntries: Object.keys(trustData).length,
        timestamp: Date.now(),
    })
})

// ── GET /health ─────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        service: 'memoryvault-mock-data-api',
        pools: pools.length,
        trustEntries: Object.keys(trustData).length,
        uptime: process.uptime(),
    })
})

// ── Start ───────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3001

app.listen(PORT, () => {
    console.log(`\n🔧 MemoryVault Mock Data API`)
    console.log(`   Port:     ${PORT}`)
    console.log(`   API Key:  ${API_KEY.slice(0, 8)}...`)
    console.log(`   Pools:    ${pools.length} pre-seeded`)
    console.log(`   Trust:    ${Object.keys(trustData).length} tokens\n`)
    console.log(`   Endpoints:`)
    console.log(`     GET  /pools/clmm?minTVL=500000&maxAgeDays=7`)
    console.log(`     GET  /trust/:token`)
    console.log(`     POST /pools/simulate`)
    console.log(`     GET  /health\n`)
})
