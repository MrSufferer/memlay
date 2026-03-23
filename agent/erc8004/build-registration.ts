import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadErc8004Config } from './config'
import type { ERC8004RegistrationFile } from './types'

const DEFAULT_CHAIN_ID = 11155111

export interface BuildRegistrationOptions {
  baseUrl?: string
  chainId?: number
  identityRegistryAddress?: string
  agentId?: number
  outputRootDir?: string
}

function parseEnvInt(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function buildAgentRegistry(chainId: number, identityRegistryAddress: string): string {
  return `eip155:${chainId}:${identityRegistryAddress}`
}

export function createRegistrationArtifacts(
  options: BuildRegistrationOptions = {}
): {
  registration: ERC8004RegistrationFile
  wellKnown: { registrations: Array<{ agentId: number; agentRegistry: string }> }
} {
  const baseUrl =
    options.baseUrl ||
    process.env.ERC8004_BASE_URL ||
    'https://example.github.io/cre-por-llm-demo'

  const chainId = options.chainId ?? parseEnvInt('ERC8004_CHAIN_ID') ?? DEFAULT_CHAIN_ID
  const identityRegistryAddress =
    options.identityRegistryAddress ||
    process.env.ERC8004_IDENTITY_REGISTRY ||
    '0x0000000000000000000000000000000000000000'

  const agentId = options.agentId ?? parseEnvInt('ERC8004_AGENT_ID') ?? 0

  const config = loadErc8004Config(baseUrl)
  const agentRegistry = buildAgentRegistry(chainId, identityRegistryAddress)

  const registrations = [
    {
      agentId,
      agentRegistry,
    },
  ]

  const registration: ERC8004RegistrationFile = {
    type: config.type,
    name: config.name,
    description: config.description,
    image: config.image,
    services: config.services,
    registrations,
    supportedTrust: config.supportedTrust,
    active: config.active,
    x402Support: config.x402Support,
  }

  const wellKnown = {
    registrations,
  }

  return { registration, wellKnown }
}

export function writeRegistrationArtifacts(options: BuildRegistrationOptions = {}): {
  registrationPath: string
  wellKnownPath: string
} {
  const outputRoot =
    options.outputRootDir ||
    fileURLToPath(new URL('../../docs', import.meta.url))

  const registrationPath = `${outputRoot}/erc8004/registration.sepolia.json`
  const wellKnownPath = `${outputRoot}/.well-known/agent-registration.json`

  const { registration, wellKnown } = createRegistrationArtifacts(options)

  mkdirSync(`${outputRoot}/erc8004`, { recursive: true })
  mkdirSync(`${outputRoot}/.well-known`, { recursive: true })

  writeFileSync(registrationPath, `${JSON.stringify(registration, null, 2)}\n`, 'utf8')
  writeFileSync(wellKnownPath, `${JSON.stringify(wellKnown, null, 2)}\n`, 'utf8')

  return { registrationPath, wellKnownPath }
}

if (import.meta.main) {
  const { registrationPath, wellKnownPath } = writeRegistrationArtifacts()
  console.log('[erc8004] Registration artifacts generated:')
  console.log(`  - ${registrationPath}`)
  console.log(`  - ${wellKnownPath}`)
}
