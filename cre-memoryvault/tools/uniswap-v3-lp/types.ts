import type { ToolResponse, RawOpportunity } from '../../protocol/tool-interface'

export interface Pool {
    id: string;
    pair: string;
    protocol: string;
    token: string;
    age: string;
    tvl: number;
    feeAPY: number;
    feeTier: number;
    tickSpacing: number;
    currentTick: number;
}

export interface TrustSignals {
    tokenSniffer: { score: number; honeypot: boolean; rugPull: boolean };
    etherscan: { verified: boolean; ownerRenounced: boolean; proxy: boolean };
    uncx: { liquidityLocked: boolean; lockDuration: string; lockPct: number };
    holders: { top10Pct: number; totalHolders: number };
}

export interface PoolsResponse {
    pools: Pool[];
    totalPools: number;
    filteredCount: number;
}

export interface TrustResponse extends TrustSignals {
    token: string;
}
