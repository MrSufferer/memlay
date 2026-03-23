import { loadDeploymentTargetConfig } from './deploy-runtime-config'

export type PrivateHttpClientMode = 'direct' | 'stub'
export type PrivateHttpMethod = 'GET' | 'POST'
export type PrivateHttpStatus = 'success' | 'stubbed' | 'skipped' | 'failed'

export interface PrivateHttpSecretHeader {
    headerName: string
    envVar: string
}

export interface PrivateHttpRequest {
    url: string
    method?: PrivateHttpMethod
    headers?: Record<string, string>
    sourceId?: string
    secretHeader?: PrivateHttpSecretHeader
}

export interface PrivateHttpResponse {
    mode: PrivateHttpClientMode
    status: PrivateHttpStatus
    statusCode?: number
    bodyJson?: unknown
    bodyText?: string
    error?: string
    metadata: {
        sourceId?: string
        reason: string
        secretEnvVar?: string
    }
}

export interface PrivateHttpClient {
    fetch(request: PrivateHttpRequest): Promise<PrivateHttpResponse>
}

export interface PrivateHttpClientOptions {
    mode?: PrivateHttpClientMode
    env?: Record<string, string | undefined>
}

function normalizeOptional(value: string | undefined): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

function resolvePrivateHttpMode(
    requestedMode: PrivateHttpClientMode | undefined,
    env: Record<string, string | undefined>
): PrivateHttpClientMode {
    const deploymentTarget = loadDeploymentTargetConfig(
        env.MEMORYVAULT_DEPLOYMENT_TARGET ?? env.AGENT_DEPLOYMENT_TARGET
    )
    if (deploymentTarget.id === 'hedera') {
        return 'stub'
    }

    if (requestedMode) {
        return requestedMode
    }

    const configured = normalizeOptional(env.PRIVATE_HTTP_MODE)
    if (configured === 'stub') {
        return 'stub'
    }

    return 'direct'
}

class DirectPrivateHttpClient implements PrivateHttpClient {
    constructor(
        private readonly env: Record<string, string | undefined>
    ) {}

    async fetch(request: PrivateHttpRequest): Promise<PrivateHttpResponse> {
        const headers = new Headers(request.headers ?? {})

        if (request.secretHeader) {
            const secret = normalizeOptional(this.env[request.secretHeader.envVar])
            if (!secret) {
                return {
                    mode: 'direct',
                    status: 'skipped',
                    metadata: {
                        sourceId: request.sourceId,
                        reason: `Missing secret env var ${request.secretHeader.envVar}`,
                        secretEnvVar: request.secretHeader.envVar,
                    },
                }
            }

            headers.set(request.secretHeader.headerName, secret)
        }

        try {
            const response = await fetch(request.url, {
                method: request.method ?? 'GET',
                headers,
            })

            const bodyText = await response.text()
            let bodyJson: unknown
            try {
                bodyJson = bodyText ? JSON.parse(bodyText) : undefined
            } catch {
                bodyJson = undefined
            }

            if (!response.ok) {
                return {
                    mode: 'direct',
                    status: 'failed',
                    statusCode: response.status,
                    bodyText,
                    bodyJson,
                    error: `HTTP ${response.status}`,
                    metadata: {
                        sourceId: request.sourceId,
                        reason: `Upstream returned HTTP ${response.status}`,
                        secretEnvVar: request.secretHeader?.envVar,
                    },
                }
            }

            return {
                mode: 'direct',
                status: 'success',
                statusCode: response.status,
                bodyText,
                bodyJson,
                metadata: {
                    sourceId: request.sourceId,
                    reason: 'Direct private HTTP request completed',
                    secretEnvVar: request.secretHeader?.envVar,
                },
            }
        } catch (error) {
            return {
                mode: 'direct',
                status: 'failed',
                error: String(error),
                metadata: {
                    sourceId: request.sourceId,
                    reason: 'Direct private HTTP request failed',
                    secretEnvVar: request.secretHeader?.envVar,
                },
            }
        }
    }
}

class StubPrivateHttpClient implements PrivateHttpClient {
    async fetch(request: PrivateHttpRequest): Promise<PrivateHttpResponse> {
        return {
            mode: 'stub',
            status: 'stubbed',
            bodyJson: [],
            metadata: {
                sourceId: request.sourceId,
                reason: 'Private alpha is disabled in stub mode',
                secretEnvVar: request.secretHeader?.envVar,
            },
        }
    }
}

export function createPrivateHttpClient(
    options: PrivateHttpClientOptions = {}
): PrivateHttpClient {
    const env = options.env ?? process.env
    const mode = resolvePrivateHttpMode(options.mode, env)
    return mode === 'stub'
        ? new StubPrivateHttpClient()
        : new DirectPrivateHttpClient(env)
}
