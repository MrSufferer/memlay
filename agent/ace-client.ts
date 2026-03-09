/**
 * ACE Client — placeholder for private transfer interactions.
 *
 * For this MVP we keep the interface small and focused on what the
 * agent needs: execute a private transfer for LP entry/exit.
 * The actual EIP-712 signing + HTTP calls to the ACE API can be
 * filled in once T2.5 (ACE setup) is complete.
 */

export interface PrivateTransferParams {
    recipient: string
    token: string
    amount: bigint
}

export interface ACEClientConfig {
    apiUrl: string
    // Additional config (API keys, signer, etc.) can be added later.
}

export class ACEClient {
    constructor(private readonly config: ACEClientConfig) {}

    /**
     * Execute a private transfer via ACE.
     *
     * NOTE: For now this is a stub that logs the intent. Once ACE
     * is wired, implement the EIP-712 signing and POST to the ACE API.
     */
    async privateTransfer(params: PrivateTransferParams): Promise<void> {
        console.log('[ACEClient] privateTransfer (stub):', {
            apiUrl: this.config.apiUrl,
            ...params,
        })
    }
}

