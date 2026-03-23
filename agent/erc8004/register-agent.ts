import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { ERC8004IdentityRegistry } from '../../contracts/abi/ERC8004IdentityRegistry'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim().length === 0) {
    throw new Error(`[erc8004] Missing required environment variable: ${name}`)
  }
  return value
}

function withHexPrefix(value: string): Hex {
  return (value.startsWith('0x') ? value : `0x${value}`) as Hex
}

function resolveRegistrationUri(): string {
  if (process.env.ERC8004_REGISTRATION_URI) {
    return process.env.ERC8004_REGISTRATION_URI
  }

  const baseUrl = process.env.ERC8004_BASE_URL || 'https://example.github.io/cre-por-llm-demo'
  return `${baseUrl.replace(/\/$/, '')}/erc8004/registration.sepolia.json`
}

async function main() {
  const rpcUrl = requireEnv('RPC_URL')
  const identityRegistry = requireEnv('ERC8004_IDENTITY_REGISTRY') as Address
  const privateKey = withHexPrefix(
    process.env.ERC8004_OWNER_PRIVATE_KEY ||
      process.env.CRE_ETH_PRIVATE_KEY ||
      process.env.PRIVATE_KEY ||
      ''
  )

  const account = privateKeyToAccount(privateKey)
  const registrationUri = resolveRegistrationUri()

  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  })

  const walletClient = createWalletClient({
    chain: sepolia,
    transport: http(rpcUrl),
    account,
  })

  const existingAgentId = process.env.ERC8004_AGENT_ID

  if (existingAgentId && existingAgentId.trim().length > 0) {
    const agentId = BigInt(existingAgentId)

    const { request } = await publicClient.simulateContract({
      account,
      address: identityRegistry,
      abi: ERC8004IdentityRegistry,
      functionName: 'setAgentURI',
      args: [agentId, registrationUri],
    })

    const txHash = await walletClient.writeContract(request)

    console.log('[erc8004] Updated existing agent URI')
    console.log(`  agentId: ${agentId.toString()}`)
    console.log(`  uri: ${registrationUri}`)
    console.log(`  tx: ${txHash}`)
    return
  }

  const { request, result } = await publicClient.simulateContract({
    account,
    address: identityRegistry,
    abi: ERC8004IdentityRegistry,
    functionName: 'register',
    args: [registrationUri],
  })

  const txHash = await walletClient.writeContract(request)

  console.log('[erc8004] Registered new agent')
  console.log(`  predictedAgentId: ${String(result)}`)
  console.log(`  uri: ${registrationUri}`)
  console.log(`  tx: ${txHash}`)
  console.log(`  next: set ERC8004_AGENT_ID=${String(result)} in your env`)
}

main().catch((error) => {
  console.error('[erc8004] register-agent failed:', error)
  process.exit(1)
})
