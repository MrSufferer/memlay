import { describe, expect, it } from 'vitest'
import { createAgentBackend } from './backend-factory'

describe('createAgentBackend', () => {
    it('creates a Sepolia backend by default', () => {
        delete process.env.MEMORYVAULT_DEPLOYMENT_TARGET

        const backend = createAgentBackend()

        expect(backend.target).toBe('sepolia')
        expect(backend.label).toContain('Sepolia')
        expect(typeof backend.tools.scan).toBe('function')
        expect(typeof backend.memory.commitEntry).toBe('function')
        expect(typeof backend.execution.enterPosition).toBe('function')
    })

    it('creates a Hedera backend with Bonzo scan support and simulated execution', async () => {
        process.env.MEMORYVAULT_DEPLOYMENT_TARGET = 'hedera'
        process.env.HEDERA_NETWORK = 'testnet'
        process.env.HEDERA_OPERATOR_ID = '0.0.1001'
        process.env.HEDERA_OPERATOR_KEY = 'operator-private-key'
        process.env.HEDERA_MIRROR_NODE_URL = 'https://mirror.example.com/api/v1'
        process.env.BONZO_EXECUTOR_MODE = 'operator'
        process.env.BONZO_DATA_SOURCE = 'mock'

        try {
            const backend = createAgentBackend()

            expect(backend.target).toBe('hedera')
            expect(typeof backend.memory.commitEntry).toBe('function')
            await expect(backend.tools.scan('bonzo-vaults')).resolves.toMatchObject({
                status: 'success',
                action: 'scan',
                toolId: 'bonzo-vaults',
            })
            await expect(
                backend.execution.enterPosition({
                    toolId: 'bonzo-vaults',
                    request: {
                        action: 'enter',
                        agentId: 'agent-hedera-01',
                        strategyType: 'custom',
                        params: {
                            vaultId: 'vault-single',
                            vaultAddress: '0xvault-single',
                            shareTokenId: '0xshare-single',
                            strategyAddress: '0xstrategy-single',
                            depositAssets: [{ symbol: 'HBAR', amount: '100' }],
                        },
                    },
                })
            ).resolves.toBeUndefined()
        } finally {
            delete process.env.MEMORYVAULT_DEPLOYMENT_TARGET
            delete process.env.HEDERA_NETWORK
            delete process.env.HEDERA_OPERATOR_ID
            delete process.env.HEDERA_OPERATOR_KEY
            delete process.env.HEDERA_MIRROR_NODE_URL
            delete process.env.BONZO_EXECUTOR_MODE
            delete process.env.BONZO_DATA_SOURCE
        }
    })

    it('fails fast when Hedera live execution is enabled with mock discovery inputs', () => {
        process.env.MEMORYVAULT_DEPLOYMENT_TARGET = 'hedera'
        process.env.HEDERA_NETWORK = 'testnet'
        process.env.HEDERA_OPERATOR_ID = '0.0.1001'
        process.env.HEDERA_OPERATOR_KEY = 'operator-private-key'
        process.env.HEDERA_MIRROR_NODE_URL = 'https://mirror.example.com/api/v1'
        process.env.BONZO_EXECUTOR_MODE = 'operator'
        process.env.BONZO_DATA_SOURCE = 'mock'
        process.env.BONZO_EXECUTION_MODE = 'live'

        try {
            expect(() => createAgentBackend()).toThrow(
                'BONZO_DATA_SOURCE=mock is not supported'
            )
        } finally {
            delete process.env.MEMORYVAULT_DEPLOYMENT_TARGET
            delete process.env.HEDERA_NETWORK
            delete process.env.HEDERA_OPERATOR_ID
            delete process.env.HEDERA_OPERATOR_KEY
            delete process.env.HEDERA_MIRROR_NODE_URL
            delete process.env.BONZO_EXECUTOR_MODE
            delete process.env.BONZO_DATA_SOURCE
            delete process.env.BONZO_EXECUTION_MODE
        }
    })

    it('creates a Hedera backend when live Bonzo execution config is present', () => {
        process.env.MEMORYVAULT_DEPLOYMENT_TARGET = 'hedera'
        process.env.HEDERA_NETWORK = 'testnet'
        process.env.HEDERA_OPERATOR_ID = '0.0.1001'
        process.env.HEDERA_OPERATOR_KEY =
            '0x0123456789012345678901234567890123456789012345678901234567890123'
        process.env.HEDERA_MIRROR_NODE_URL = 'https://mirror.example.com/api/v1'
        process.env.BONZO_EXECUTOR_MODE = 'operator'
        process.env.BONZO_DATA_SOURCE = 'contracts'
        process.env.BONZO_EXECUTION_MODE = 'live'
        process.env.BONZO_CONTRACT_RPC_URL = 'https://rpc.example.com'
        process.env.BONZO_CONTRACT_VAULTS_JSON = '[]'

        try {
            const backend = createAgentBackend()

            expect(backend.target).toBe('hedera')
            expect(typeof backend.execution.enterPosition).toBe('function')
        } finally {
            delete process.env.MEMORYVAULT_DEPLOYMENT_TARGET
            delete process.env.HEDERA_NETWORK
            delete process.env.HEDERA_OPERATOR_ID
            delete process.env.HEDERA_OPERATOR_KEY
            delete process.env.HEDERA_MIRROR_NODE_URL
            delete process.env.BONZO_EXECUTOR_MODE
            delete process.env.BONZO_DATA_SOURCE
            delete process.env.BONZO_EXECUTION_MODE
            delete process.env.BONZO_CONTRACT_RPC_URL
            delete process.env.BONZO_CONTRACT_VAULTS_JSON
        }
    })
})
