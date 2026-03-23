import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { loadHederaEnvConfig } from './env'

function makeBaseEnv(): Record<string, string> {
    return {
        HEDERA_NETWORK: 'testnet',
        HEDERA_OPERATOR_ID: '0.0.1001',
        HEDERA_OPERATOR_KEY: 'operator-private-key',
        HEDERA_MIRROR_NODE_URL: 'https://mirror.example.com/api/v1',
        BONZO_EXECUTOR_MODE: 'operator',
    }
}

describe('loadHederaEnvConfig', () => {
    it('loads the minimal Hedera config from direct env vars', () => {
        const config = loadHederaEnvConfig(makeBaseEnv())

        expect(config).toMatchObject({
            network: 'testnet',
            operatorAccountId: '0.0.1001',
            operatorPrivateKey: 'operator-private-key',
            operatorPrivateKeySource: 'env',
            mirrorNodeUrl: 'https://mirror.example.com/api/v1',
            stateStorePath: '.agent/hedera-state.json',
            bonzoDataSource: 'mock',
            bonzoExecutionMode: 'simulate',
            bonzoMinApyDeltaBps: 0,
            privateHttpMode: 'stub',
            bonzoContractEnv: {},
            bonzoExecutorMode: 'operator',
            signersShareAccount: true,
        })
        expect(config.executionSigner).toMatchObject({
            plane: 'execution',
            owner: 'operator',
            accountId: '0.0.1001',
        })
    })

    it('loads secrets from *_FILE env vars and captures Bonzo overrides', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hedera-env-'))

        try {
            const operatorKeyPath = join(dir, 'operator.key')
            const executorKeyPath = join(dir, 'executor.key')
            writeFileSync(operatorKeyPath, 'operator-from-file\n')
            writeFileSync(executorKeyPath, 'executor-from-file\n')

            const config = loadHederaEnvConfig({
                ...makeBaseEnv(),
                HEDERA_OPERATOR_KEY: undefined,
                HEDERA_OPERATOR_KEY_FILE: operatorKeyPath,
                HEDERA_AGENT_ID: '0.0.2002',
                HEDERA_AGENT_KEY: 'agent-private-key',
                BONZO_EXECUTOR_MODE: 'dedicated',
                BONZO_EXECUTOR_ACCOUNT_ID: '0.0.3003',
                BONZO_EXECUTOR_PRIVATE_KEY_FILE: executorKeyPath,
                BONZO_DATA_SOURCE: 'contracts',
                BONZO_EXECUTION_MODE: 'live',
                BONZO_MIN_APY_DELTA_BPS: '125',
                BONZO_CONTRACT_ROUTER: '0xrouter',
                OAUTH3_PROXY_URL: 'https://oauth3.example.com',
                OAUTH3_OWNER_APPROVAL_MODE: 'manual',
            })

            expect(config.operatorPrivateKey).toBe('operator-from-file')
            expect(config.operatorPrivateKeySource).toBe('file')
            expect(config.agentPrivateKey).toBe('agent-private-key')
            expect(config.agentPrivateKeySource).toBe('env')
            expect(config.bonzoExecutorMode).toBe('dedicated')
            expect(config.bonzoExecutorPrivateKey).toBe('executor-from-file')
            expect(config.bonzoExecutorPrivateKeySource).toBe('file')
            expect(config.executionSigner).toMatchObject({
                plane: 'execution',
                owner: 'bonzo-executor',
                accountId: '0.0.3003',
            })
            expect(config.signersShareAccount).toBe(false)
            expect(config.bonzoDataSource).toBe('contracts')
            expect(config.bonzoExecutionMode).toBe('live')
            expect(config.bonzoMinApyDeltaBps).toBe(125)
            expect(config.bonzoContractEnv).toEqual({
                BONZO_CONTRACT_ROUTER: '0xrouter',
            })
            expect(config.oauth3ProxyUrl).toBe('https://oauth3.example.com')
            expect(config.oauth3OwnerApprovalMode).toBe('manual')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('rejects duplicate direct and file-based secrets', () => {
        expect(() =>
            loadHederaEnvConfig({
                ...makeBaseEnv(),
                HEDERA_OPERATOR_KEY_FILE: '/tmp/operator.key',
            })
        ).toThrow('Set either HEDERA_OPERATOR_KEY or HEDERA_OPERATOR_KEY_FILE')
    })

    it('rejects incomplete agent or executor credential pairs', () => {
        expect(() =>
            loadHederaEnvConfig({
                ...makeBaseEnv(),
                HEDERA_AGENT_ID: '0.0.2002',
            })
        ).toThrow('HEDERA_AGENT_KEY is required when HEDERA_AGENT_ID is set')

        expect(() =>
            loadHederaEnvConfig({
                ...makeBaseEnv(),
                BONZO_EXECUTOR_MODE: 'dedicated',
                BONZO_EXECUTOR_PRIVATE_KEY: 'executor-private-key',
            })
        ).toThrow('BONZO_EXECUTOR_ACCOUNT_ID is required when BONZO_EXECUTOR_PRIVATE_KEY is set')

        expect(() =>
            loadHederaEnvConfig({
                ...makeBaseEnv(),
                BONZO_EXECUTION_MODE: 'live',
                BONZO_EXECUTOR_MODE: 'dedicated',
                BONZO_EXECUTOR_ACCOUNT_ID: '0.0.3003',
            })
        ).toThrow('BONZO_EXECUTOR_PRIVATE_KEY is required when BONZO_EXECUTOR_ACCOUNT_ID is set')
    })

    it('rejects ambiguous execution signer ownership config', () => {
        expect(() =>
            loadHederaEnvConfig({
                ...makeBaseEnv(),
                BONZO_EXECUTOR_ACCOUNT_ID: '0.0.3003',
                BONZO_EXECUTOR_PRIVATE_KEY: 'executor-private-key',
            })
        ).toThrow('must be unset when BONZO_EXECUTOR_MODE=operator')
    })

    it('rejects unsupported Hedera env values', () => {
        expect(() =>
            loadHederaEnvConfig({
                ...makeBaseEnv(),
                HEDERA_NETWORK: 'invalidnet',
            })
        ).toThrow('HEDERA_NETWORK must be one of')

        expect(() =>
            loadHederaEnvConfig({
                ...makeBaseEnv(),
                BONZO_EXECUTOR_MODE: 'implicit',
            })
        ).toThrow('BONZO_EXECUTOR_MODE must be one of')

        expect(() =>
            loadHederaEnvConfig({
                ...makeBaseEnv(),
                BONZO_EXECUTION_MODE: 'broadcast',
            })
        ).toThrow('BONZO_EXECUTION_MODE must be one of')

        expect(() =>
            loadHederaEnvConfig({
                ...makeBaseEnv(),
                PRIVATE_HTTP_MODE: 'oauth3',
            })
        ).toThrow('PRIVATE_HTTP_MODE must remain stub')

        expect(() =>
            loadHederaEnvConfig({
                ...makeBaseEnv(),
                BONZO_MIN_APY_DELTA_BPS: '-1',
            })
        ).toThrow('BONZO_MIN_APY_DELTA_BPS must be a non-negative integer')
    })
})
