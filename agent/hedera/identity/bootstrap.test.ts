import { describe, expect, it, vi } from 'vitest'
import type { HederaEnvConfig } from '../env'
import {
    createOrAttachHederaAgent,
    type HederaIdentityAdapter,
    normalizeHederaCreateAgentResult,
} from './bootstrap'

function makeEnv(): HederaEnvConfig {
    return {
        network: 'testnet',
        operatorAccountId: '0.0.1001',
        operatorPrivateKey: 'operator-private-key',
        operatorPrivateKeySource: 'env',
        mirrorNodeUrl: 'https://mirror.example.com/api/v1',
        stateStorePath: '.agent/hedera-state.json',
        bonzoDataSource: 'mock',
        bonzoMinApyDeltaBps: 0,
        bonzoExecutorMode: 'operator',
        bonzoContractEnv: {},
        privateHttpMode: 'stub',
        controlPlaneSigner: {
            plane: 'control',
            owner: 'operator',
            accountId: '0.0.1001',
            privateKey: 'operator-private-key',
            privateKeySource: 'env',
        },
        executionSigner: {
            plane: 'execution',
            owner: 'operator',
            accountId: '0.0.1001',
            privateKey: 'operator-private-key',
            privateKeySource: 'env',
        },
        signersShareAccount: true,
    }
}

function makeAdapter(): HederaIdentityAdapter {
    return {
        createAndRegisterAgent: vi.fn(),
        getAgentProfile: vi.fn(),
        getAccountMemo: vi.fn(),
    }
}

describe('createOrAttachHederaAgent', () => {
    it('normalizes HOL registration results that return agent data under metadata', () => {
        expect(
            normalizeHederaCreateAgentResult({
                metadata: {
                    accountId: '0.0.3003',
                    privateKey: 'generated-agent-key',
                    inboundTopicId: '0.0.7101',
                    outboundTopicId: '0.0.7102',
                    profileTopicId: '0.0.7103',
                    operatorId: '0.0.1001@0.0.3003',
                },
            })
        ).toEqual({
            accountId: '0.0.3003',
            privateKey: 'generated-agent-key',
            inboundTopicId: '0.0.7101',
            outboundTopicId: '0.0.7102',
            profileTopicId: '0.0.7103',
            operatorId: '0.0.1001@0.0.3003',
        })
    })

    it('attaches to an existing agent when credentials are present', async () => {
        const adapter = makeAdapter()
        const env: HederaEnvConfig = {
            ...makeEnv(),
            agentAccountId: '0.0.2002',
            agentPrivateKey: 'agent-private-key',
            agentPrivateKeySource: 'env',
        }

        vi.mocked(adapter.getAgentProfile).mockResolvedValue({
            inboundTopicId: '0.0.7001',
            outboundTopicId: '0.0.7002',
        })
        vi.mocked(adapter.getAccountMemo).mockResolvedValue(
            'hcs-11:hcs://1/0.0.7003'
        )

        const result = await createOrAttachHederaAgent(env, undefined, { adapter })

        expect(result).toEqual({
            accountId: '0.0.2002',
            privateKeyRef: 'env:HEDERA_AGENT_KEY',
            inboundTopicId: '0.0.7001',
            outboundTopicId: '0.0.7002',
            profileTopicId: '0.0.7003',
            network: 'testnet',
            created: false,
        })
        expect(adapter.createAndRegisterAgent).not.toHaveBeenCalled()
    })

    it('creates and registers a new agent when no existing credentials are present', async () => {
        const adapter = makeAdapter()
        vi.mocked(adapter.createAndRegisterAgent).mockResolvedValue({
            accountId: '0.0.3003',
            privateKey: 'generated-agent-key',
            inboundTopicId: '0.0.7101',
            outboundTopicId: '0.0.7102',
            profileTopicId: '0.0.7103',
            operatorId: '0.0.7101@0.0.3003',
        })

        const result = await createOrAttachHederaAgent(
            makeEnv(),
            {
                name: 'MemoryVault Hedera',
                description: 'Autonomous yield-selection agent',
                profilePicture: {
                    buffer: Buffer.from('png-bytes'),
                    fileName: 'agent.png',
                },
            },
            { adapter }
        )

        expect(result).toEqual({
            accountId: '0.0.3003',
            privateKeyRef: 'runtime:generated-agent-key',
            inboundTopicId: '0.0.7101',
            outboundTopicId: '0.0.7102',
            profileTopicId: '0.0.7103',
            network: 'testnet',
            created: true,
            operatorId: '0.0.7101@0.0.3003',
            agentPrivateKey: 'generated-agent-key',
        })
        expect(adapter.getAgentProfile).not.toHaveBeenCalled()
        expect(adapter.getAccountMemo).not.toHaveBeenCalled()
    })

    it('rejects attach mode when the existing profile is missing topic metadata', async () => {
        const adapter = makeAdapter()
        const env: HederaEnvConfig = {
            ...makeEnv(),
            agentAccountId: '0.0.2002',
            agentPrivateKey: 'agent-private-key',
            agentPrivateKeySource: 'file',
        }

        vi.mocked(adapter.getAgentProfile).mockResolvedValue({
            inboundTopicId: '0.0.7001',
        })
        vi.mocked(adapter.getAccountMemo).mockResolvedValue(
            'hcs-11:hcs://1/0.0.7003'
        )

        await expect(
            createOrAttachHederaAgent(env, undefined, { adapter })
        ).rejects.toThrow('missing inbound/outbound topic metadata')
    })

    it('rejects create mode when profile metadata is missing', async () => {
        const adapter = makeAdapter()

        await expect(
            createOrAttachHederaAgent(makeEnv(), undefined, { adapter })
        ).rejects.toThrow('Profile metadata with a profile picture is required')
    })
})
