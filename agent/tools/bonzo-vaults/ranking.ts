import type { BonzoPositionState } from '../../hedera/positions/bonzo'
import type { BonzoVaultOpportunity } from './opportunities'

export interface BestVaultSelection {
    currentVaultId: string | null
    bestVaultId: string | null
    bestApy: number
    apyDeltaBps: number
    rebalance: boolean
    reason: string
}

function compareByApyDesc(
    left: BonzoVaultOpportunity,
    right: BonzoVaultOpportunity
): number {
    if (left.apy === right.apy) {
        return 0
    }

    return right.apy - left.apy
}

function findCurrentVaultOpportunity(
    opportunities: BonzoVaultOpportunity[],
    currentPosition: BonzoPositionState | null
): BonzoVaultOpportunity | null {
    if (!currentPosition) {
        return null
    }

    return opportunities.find(
        (opportunity) => opportunity.vaultId === currentPosition.vaultId
    ) ?? null
}

function findBestOpportunity(
    opportunities: BonzoVaultOpportunity[],
    currentOpportunity: BonzoVaultOpportunity | null
): BonzoVaultOpportunity | null {
    if (opportunities.length === 0) {
        return null
    }

    let best = opportunities[0]

    for (const candidate of opportunities.slice(1)) {
        const apyComparison = compareByApyDesc(best, candidate)

        if (apyComparison > 0) {
            best = candidate
            continue
        }

        if (
            apyComparison === 0 &&
            currentOpportunity &&
            candidate.vaultId === currentOpportunity.vaultId
        ) {
            best = candidate
        }
    }

    return best
}

function toBasisPoints(deltaPercent: number): number {
    return Math.round(deltaPercent * 100)
}

export function selectBestBonzoVault(args: {
    opportunities: BonzoVaultOpportunity[]
    currentPosition: BonzoPositionState | null
    minApyDeltaBps: number
}): BestVaultSelection {
    const { opportunities, currentPosition, minApyDeltaBps } = args

    if (!Number.isInteger(minApyDeltaBps) || minApyDeltaBps < 0) {
        throw new Error('[bonzo-ranking] minApyDeltaBps must be a non-negative integer')
    }

    if (opportunities.length === 0) {
        return {
            currentVaultId: currentPosition?.vaultId ?? null,
            bestVaultId: null,
            bestApy: 0,
            apyDeltaBps: 0,
            rebalance: false,
            reason: 'No Bonzo vault opportunities are available',
        }
    }

    const currentOpportunity = findCurrentVaultOpportunity(opportunities, currentPosition)
    const bestOpportunity = findBestOpportunity(opportunities, currentOpportunity)

    if (!bestOpportunity) {
        return {
            currentVaultId: currentPosition?.vaultId ?? null,
            bestVaultId: null,
            bestApy: 0,
            apyDeltaBps: 0,
            rebalance: false,
            reason: 'No Bonzo vault opportunities are available',
        }
    }

    if (!currentPosition) {
        return {
            currentVaultId: null,
            bestVaultId: bestOpportunity.vaultId,
            bestApy: bestOpportunity.apy,
            apyDeltaBps: 0,
            rebalance: true,
            reason: `No current Bonzo position is active; select ${bestOpportunity.vaultId} as the highest APY vault`,
        }
    }

    if (!currentOpportunity) {
        return {
            currentVaultId: currentPosition.vaultId,
            bestVaultId: bestOpportunity.vaultId,
            bestApy: bestOpportunity.apy,
            apyDeltaBps: 0,
            rebalance: true,
            reason:
                `Current vault ${currentPosition.vaultId} is not present in the candidate set; ` +
                `select ${bestOpportunity.vaultId} as the highest APY vault`,
        }
    }

    if (bestOpportunity.vaultId === currentOpportunity.vaultId) {
        return {
            currentVaultId: currentPosition.vaultId,
            bestVaultId: bestOpportunity.vaultId,
            bestApy: bestOpportunity.apy,
            apyDeltaBps: 0,
            rebalance: false,
            reason: `Current vault ${currentOpportunity.vaultId} remains the highest APY candidate`,
        }
    }

    const apyDeltaBps = toBasisPoints(bestOpportunity.apy - currentOpportunity.apy)

    if (apyDeltaBps < minApyDeltaBps) {
        return {
            currentVaultId: currentPosition.vaultId,
            bestVaultId: bestOpportunity.vaultId,
            bestApy: bestOpportunity.apy,
            apyDeltaBps,
            rebalance: false,
            reason:
                `APY delta ${apyDeltaBps} bps is below the configured rebalance threshold ` +
                `of ${minApyDeltaBps} bps`,
        }
    }

    return {
        currentVaultId: currentPosition.vaultId,
        bestVaultId: bestOpportunity.vaultId,
        bestApy: bestOpportunity.apy,
        apyDeltaBps,
        rebalance: true,
        reason:
            `Vault ${bestOpportunity.vaultId} exceeds current vault ${currentPosition.vaultId} ` +
            `by ${apyDeltaBps} bps`,
    }
}
