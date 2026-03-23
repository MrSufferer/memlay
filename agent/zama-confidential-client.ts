import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  parseDefaultEncryptedInputPayload,
  parseEncryptedInputPayloadMap,
  resolveEncryptedInputPayload,
  type EncryptedInputPayload,
  type EncryptedInputPayloadMap,
} from './zama-encrypted-input'

const CONFIDENTIAL_TOKEN_ABI = parseAbi([
  'function transfer(address to, bytes32 encryptedAmountHandle, bytes inputProof) external returns (bool)',
])

export interface PrivateTransferParams {
  recipient: string
  token: string
  amount: bigint
}

export type ZamaTransferMode = 'simulate' | 'onchain'

export interface ZamaConfidentialTransferClientConfig {
  mode?: ZamaTransferMode
  rpcUrl?: string
  chainId?: number
  privateKey?: string
  tokenAddress?: string
  encryptedInputsJson?: string
  defaultHandle?: string
  defaultInputProof?: string
  waitForReceipt?: boolean
}

export class ZamaConfidentialTransferClient {
  private readonly mode: ZamaTransferMode
  private readonly encryptedMapping: EncryptedInputPayloadMap
  private readonly defaultPayload?: EncryptedInputPayload

  constructor(private readonly config: ZamaConfidentialTransferClientConfig) {
    this.mode = config.mode ?? 'simulate'
    this.encryptedMapping = parseEncryptedInputPayloadMap(config.encryptedInputsJson)
    this.defaultPayload = parseDefaultEncryptedInputPayload(
      config.defaultHandle,
      config.defaultInputProof
    )

    if (this.mode === 'onchain') {
      this.requireOnchainConfig()
    }
  }

  async privateTransfer(params: PrivateTransferParams): Promise<void> {
    if (this.mode === 'simulate') {
      console.log('[ZamaConfidentialTransferClient] simulate transfer:', {
        recipient: params.recipient,
        token: params.token,
        amount: params.amount.toString(),
      })
      return
    }

    this.requireOnchainConfig()

    const recipient = this.toAddress(params.recipient, 'recipient')
    const token = this.toAddress(params.token || this.config.tokenAddress || '', 'token')
    const payload = resolveEncryptedInputPayload({
      amount: params.amount,
      mapping: this.encryptedMapping,
      defaultPayload: this.defaultPayload,
    })

    const account = privateKeyToAccount(this.config.privateKey as Hex)
    const transport = http(this.config.rpcUrl)
    const walletClient = createWalletClient({ account, transport })

    const txHash = await walletClient.writeContract({
      address: token,
      abi: CONFIDENTIAL_TOKEN_ABI,
      functionName: 'transfer',
      args: [recipient, payload.handle, payload.inputProof],
    })

    if (this.config.waitForReceipt !== false) {
      const publicClient = createPublicClient({ transport })
      await publicClient.waitForTransactionReceipt({ hash: txHash })
    }

    console.log('[ZamaConfidentialTransferClient] transfer confirmed:', {
      txHash,
      recipient,
      token,
      amount: params.amount.toString(),
    })
  }

  private requireOnchainConfig(): void {
    if (!this.config.rpcUrl || !this.config.rpcUrl.trim()) {
      throw new Error('Missing ZAMA_RPC_URL for onchain transfer mode')
    }

    if (!this.config.privateKey || !this.config.privateKey.trim()) {
      throw new Error('Missing ZAMA_PRIVATE_KEY (or CRE_ETH_PRIVATE_KEY fallback) for onchain transfer mode')
    }

    if (!this.config.tokenAddress || !this.config.tokenAddress.trim()) {
      throw new Error('Missing ZAMA_CONFIDENTIAL_TOKEN_ADDRESS for onchain transfer mode')
    }

    if (!this.config.chainId || Number.isNaN(this.config.chainId) || this.config.chainId <= 0) {
      throw new Error('Missing or invalid ZAMA_CHAIN_ID for onchain transfer mode')
    }

    this.toAddress(this.config.tokenAddress, 'ZAMA_CONFIDENTIAL_TOKEN_ADDRESS')
  }

  private toAddress(raw: string, label: string): Address {
    if (!isAddress(raw)) {
      throw new Error(`Invalid address for ${label}: ${raw}`)
    }
    return raw
  }
}
