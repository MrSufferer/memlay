import { createHash, randomUUID } from 'node:crypto'
import { hexToBytes, type Hex } from 'viem'
import { sign } from 'viem/accounts'
import { normalizeWorkflowId } from './workflow-ids'

export interface DeployedTriggerClientConfig {
    gatewayUrl: string
    privateKey: string
    timeoutMs?: number
    tokenTtlSeconds?: number
}

export interface TriggerWorkflowRequest {
    workflowId: string
    input: unknown
    requestId?: string | number
}

function toBase64Url(data: string | Uint8Array): string {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    return bytes
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '')
}

function normalizePrivateKey(privateKey: string): Hex {
    if (!privateKey) {
        throw new Error('[DeployedTriggerClient] privateKey is required')
    }
    const withPrefix = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
    return withPrefix as Hex
}

function parseMaybeJson(value: unknown): unknown {
    if (typeof value !== 'string') return value

    const trimmed = value.trim()
    if (!trimmed) return value

    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
        try {
            return JSON.parse(trimmed)
        } catch {
            return value
        }
    }

    return value
}

function extractWorkflowResultPayload(response: unknown): unknown {
    if (response == null || typeof response !== 'object') return response

    const json = response as Record<string, unknown>

    if (json.error) {
        const err = json.error as Record<string, unknown>
        const message = String(err.message ?? 'Unknown JSON-RPC error')
        const code = err.code != null ? ` (code=${String(err.code)})` : ''
        throw new Error(`[DeployedTriggerClient] Gateway returned error${code}: ${message}`)
    }

    const resultRoot = (json.result ?? json.data ?? json) as Record<string, unknown>
    const candidates: unknown[] = [
        resultRoot.output,
        resultRoot.response,
        resultRoot.payload,
        resultRoot.executionResult,
        resultRoot.result,
        resultRoot,
    ]

    for (const candidate of candidates) {
        if (candidate == null) continue
        return parseMaybeJson(candidate)
    }

    return response
}

export class DeployedTriggerClient {
    private readonly gatewayUrl: string
    private readonly privateKey: Hex
    private readonly timeoutMs: number
    private readonly tokenTtlSeconds: number

    constructor(config: DeployedTriggerClientConfig) {
        this.gatewayUrl = config.gatewayUrl
        this.privateKey = normalizePrivateKey(config.privateKey)
        this.timeoutMs = config.timeoutMs ?? 30_000
        this.tokenTtlSeconds = config.tokenTtlSeconds ?? 300
    }

    async triggerWorkflow<T = unknown>(request: TriggerWorkflowRequest): Promise<T> {
        const jwt = await this.buildJwt()

        const rpcBody = {
            jsonrpc: '2.0',
            id: request.requestId ?? Date.now(),
            method: 'workflow_trigger',
            params: {
                workflowId: normalizeWorkflowId(request.workflowId),
                workflowID: normalizeWorkflowId(request.workflowId),
                input: request.input,
                payload: request.input,
            },
        }

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)

        try {
            const resp = await fetch(this.gatewayUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${jwt}`,
                },
                body: JSON.stringify(rpcBody),
                signal: controller.signal,
            })

            const rawText = await resp.text()
            if (!resp.ok) {
                throw new Error(
                    `[DeployedTriggerClient] HTTP ${resp.status} ${resp.statusText}: ${rawText.slice(0, 500)}`
                )
            }

            let parsed: unknown = rawText
            if (rawText.trim().startsWith('{') || rawText.trim().startsWith('[')) {
                parsed = JSON.parse(rawText)
            }

            return extractWorkflowResultPayload(parsed) as T
        } finally {
            clearTimeout(timer)
        }
    }

    private async buildJwt(): Promise<string> {
        const now = Math.floor(Date.now() / 1000)
        const header = {
            alg: 'ES256K',
            typ: 'JWT',
        }
        const payload = {
            iat: now,
            exp: now + this.tokenTtlSeconds,
            jti: randomUUID(),
            aud: 'cre-gateway',
        }

        const encodedHeader = toBase64Url(JSON.stringify(header))
        const encodedPayload = toBase64Url(JSON.stringify(payload))
        const signingInput = `${encodedHeader}.${encodedPayload}`

        const hashHex = `0x${createHash('sha256').update(signingInput).digest('hex')}`
        const signatureHex = await sign({
            hash: hashHex,
            privateKey: this.privateKey,
            to: 'hex',
        })

        const encodedSignature = toBase64Url(hexToBytes(signatureHex))
        return `${signingInput}.${encodedSignature}`
    }
}
