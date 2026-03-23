import { mkdtempSync, writeFileSync } from 'node:fs'
import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HederaEnvConfig } from '../env'
import type { HederaAgentBootstrapResult } from './bootstrap'
import { HederaAgentStateStore } from './state-store'

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

function makeExistingBootstrap(): HederaAgentBootstrapResult {
    return {
        accountId: '0.0.2002',
        privateKeyRef: 'env:HEDERA_AGENT_KEY',
        inboundTopicId: '0.0.7001',
        outboundTopicId: '0.0.7002',
        profileTopicId: '0.0.7003',
        network: 'testnet',
        created: false,
    }
}

function makeCreatedBootstrap(): HederaAgentBootstrapResult {
    return {
        accountId: '0.0.3003',
        privateKeyRef: 'runtime:generated-agent-key',
        inboundTopicId: '0.0.7101',
        outboundTopicId: '0.0.7102',
        profileTopicId: '0.0.7103',
        network: 'testnet',
        created: true,
        agentPrivateKey: 'generated-private-key',
    }
}

describe('HederaAgentStateStore', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('persists and reloads env-backed agent state without copying secrets into JSON', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hedera-state-'))
        const store = new HederaAgentStateStore(join(dir, 'hedera-state.json'))

        const state = await store.save(makeEnv(), makeExistingBootstrap())
        const loaded = await store.load()
        const raw = await readFile(join(dir, 'hedera-state.json'), 'utf8')

        expect(loaded).toEqual(state)
        expect(raw).toContain('"privateKeyRef": "env:HEDERA_AGENT_KEY"')
        expect(raw).not.toContain('generated-private-key')
        expect(await store.getFileMode()).toBe(0o600)
    })

    it('writes generated agent keys to a separate restricted file and stores only a file ref', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hedera-state-'))
        const statePath = join(dir, 'hedera-state.json')
        const keyPath = join(dir, 'hedera-agent.key')
        const store = new HederaAgentStateStore(statePath)

        const state = await store.save(
            makeEnv(),
            makeCreatedBootstrap(),
            { generatedKeyPath: keyPath }
        )

        const keyContents = await readFile(keyPath, 'utf8')
        const keyMode = (await stat(keyPath)).mode & 0o777

        expect(state.privateKeyRef).toBe(`file:${keyPath}`)
        expect(keyContents).toBe('generated-private-key\n')
        expect(keyMode).toBe(0o600)
    })

    it('rejects malformed persisted state files', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hedera-state-'))
        const statePath = join(dir, 'hedera-state.json')
        writeFileSync(statePath, JSON.stringify({
            version: 1,
            accountId: '0.0.2002',
            privateKeyRef: 'env:HEDERA_AGENT_KEY',
        }))

        const store = new HederaAgentStateStore(statePath)

        await expect(store.load()).rejects.toThrow('missing required Hedera agent fields')
    })
})
