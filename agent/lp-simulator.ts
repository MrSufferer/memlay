/**
 * LP Simulator — simple helpers for sizing positions and logging
 * simulated LP behavior. For the current MVP we keep this minimal
 * and focused on calculating an amount from risk config.
 */

import type { TraderTemplate } from './trader-template'

/**
 * Calculate position size based on trader risk config and a given
 * wallet balance. This is a pure helper and can be swapped out for
 * a full Uniswap V3 math simulator later.
 */
export function calculatePositionAmount(
    template: TraderTemplate,
    walletBalance: bigint
): bigint {
    const pct = template.risk.maxPositionPct
    const scaled = BigInt(Math.floor(Number(walletBalance) * pct))
    return scaled > 0n ? scaled : 0n
}

