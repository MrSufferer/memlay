import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ERC8004DeploymentConfig, ERC8004ServiceEntry, ReliabilityEndpointConfig } from './types'

const DEFAULT_BASE_URL =
  process.env.ERC8004_BASE_URL ||
  'https://example.github.io/cre-por-llm-demo'

function replaceBaseUrl(value: string, baseUrl: string): string {
  return value.replaceAll('{{BASE_URL}}', baseUrl.replace(/\/$/, ''))
}

export function loadErc8004Config(baseUrl = DEFAULT_BASE_URL): ERC8004DeploymentConfig {
  const configPath = fileURLToPath(new URL('./config.sepolia.json', import.meta.url))
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as ERC8004DeploymentConfig

  const services: ERC8004ServiceEntry[] = raw.services.map(service => ({
    ...service,
    endpoint: replaceBaseUrl(service.endpoint, baseUrl),
  }))

  const reliabilityEndpoints: ReliabilityEndpointConfig[] = raw.reliabilityEndpoints.map(endpoint => ({
    ...endpoint,
    endpoint: replaceBaseUrl(endpoint.endpoint, baseUrl),
  }))

  return {
    ...raw,
    image: replaceBaseUrl(raw.image, baseUrl),
    services,
    reliabilityEndpoints,
  }
}
