import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPrivateHttpClient } from './private-http-client'

describe('createPrivateHttpClient', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('defaults to stub mode for the Hedera target', async () => {
        const fetchSpy = vi.fn()
        vi.stubGlobal('fetch', fetchSpy)

        const client = createPrivateHttpClient({
            env: {
                MEMORYVAULT_DEPLOYMENT_TARGET: 'hedera',
            },
        })

        const response = await client.fetch({
            url: 'https://example.com/private-alpha',
            sourceId: 'crypto-news51',
            secretHeader: {
                headerName: 'x-api-key',
                envVar: 'RAPIDAPI_KEY_VAR',
            },
        })

        expect(response.mode).toBe('stub')
        expect(response.status).toBe('stubbed')
        expect(response.bodyJson).toEqual([])
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('performs a direct request and injects the configured secret header', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify([{ title: 'alpha' }]),
        })
        vi.stubGlobal('fetch', fetchSpy)

        const client = createPrivateHttpClient({
            env: {
                MEMORYVAULT_DEPLOYMENT_TARGET: 'sepolia',
                RAPIDAPI_KEY_VAR: 'rapid-key',
            },
        })

        const response = await client.fetch({
            url: 'https://example.com/private-alpha',
            sourceId: 'crypto-news51',
            headers: {
                'x-rapidapi-host': 'crypto-news51.p.rapidapi.com',
            },
            secretHeader: {
                headerName: 'x-rapidapi-key',
                envVar: 'RAPIDAPI_KEY_VAR',
            },
        })

        expect(response.mode).toBe('direct')
        expect(response.status).toBe('success')
        expect(response.bodyJson).toEqual([{ title: 'alpha' }])
        expect(fetchSpy).toHaveBeenCalledOnce()
        expect(fetchSpy.mock.calls[0]?.[1]?.headers.get('x-rapidapi-key')).toBe('rapid-key')
    })

    it('returns skipped when direct mode is requested without the required secret', async () => {
        const fetchSpy = vi.fn()
        vi.stubGlobal('fetch', fetchSpy)

        const client = createPrivateHttpClient({
            mode: 'direct',
            env: {},
        })

        const response = await client.fetch({
            url: 'https://example.com/private-alpha',
            secretHeader: {
                headerName: 'x-api-key',
                envVar: 'RAPIDAPI_KEY_VAR',
            },
        })

        expect(response.status).toBe('skipped')
        expect(response.metadata.reason).toContain('Missing secret env var')
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('hard-locks Hedera to stub mode even when direct mode is requested explicitly', async () => {
        const fetchSpy = vi.fn()
        vi.stubGlobal('fetch', fetchSpy)

        const client = createPrivateHttpClient({
            mode: 'direct',
            env: {
                MEMORYVAULT_DEPLOYMENT_TARGET: 'hedera',
                RAPIDAPI_KEY_VAR: 'rapid-key',
            },
        })

        const response = await client.fetch({
            url: 'https://example.com/private-alpha',
            sourceId: 'crypto-news51',
            secretHeader: {
                headerName: 'x-api-key',
                envVar: 'RAPIDAPI_KEY_VAR',
            },
        })

        expect(response.mode).toBe('stub')
        expect(response.status).toBe('stubbed')
        expect(fetchSpy).not.toHaveBeenCalled()
    })
})
