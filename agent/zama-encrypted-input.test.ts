import { describe, expect, it } from 'vitest'
import {
  parseDefaultEncryptedInputPayload,
  parseEncryptedInputPayloadMap,
  resolveEncryptedInputPayload,
} from './zama-encrypted-input'

const HANDLE_A =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HANDLE_B =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const PROOF_A = '0x1234abcd'
const PROOF_B = '0xabcd1234'

describe('zama-encrypted-input', () => {
  it('parses encrypted input mapping JSON', () => {
    const mapping = parseEncryptedInputPayloadMap(
      JSON.stringify({
        '100': { handle: HANDLE_A, inputProof: PROOF_A },
      })
    )

    expect(mapping['100']).toEqual({ handle: HANDLE_A, inputProof: PROOF_A })
  })

  it('throws on malformed JSON', () => {
    expect(() => parseEncryptedInputPayloadMap('{')).toThrow(
      'Invalid ZAMA_ENCRYPTED_INPUTS_JSON: expected valid JSON object'
    )
  })

  it('resolves exact amount payload when present', () => {
    const payload = resolveEncryptedInputPayload({
      amount: 42n,
      mapping: {
        '42': { handle: HANDLE_A, inputProof: PROOF_A },
      },
    })

    expect(payload).toEqual({ handle: HANDLE_A, inputProof: PROOF_A })
  })

  it('falls back to default payload when amount key is missing', () => {
    const payload = resolveEncryptedInputPayload({
      amount: 43n,
      mapping: {
        '42': { handle: HANDLE_A, inputProof: PROOF_A },
      },
      defaultPayload: { handle: HANDLE_B, inputProof: PROOF_B },
    })

    expect(payload).toEqual({ handle: HANDLE_B, inputProof: PROOF_B })
  })

  it('throws when no payload exists for amount and no default is set', () => {
    expect(() =>
      resolveEncryptedInputPayload({
        amount: 999n,
        mapping: {},
      })
    ).toThrow('Missing encrypted payload for amount=999')
  })

  it('parses default payload only when handle and proof are both provided', () => {
    expect(parseDefaultEncryptedInputPayload(HANDLE_A, PROOF_A)).toEqual({
      handle: HANDLE_A,
      inputProof: PROOF_A,
    })

    expect(parseDefaultEncryptedInputPayload(undefined, undefined)).toBeUndefined()
    expect(() => parseDefaultEncryptedInputPayload(HANDLE_A, undefined)).toThrow(
      'ZAMA_DEFAULT_HANDLE and ZAMA_DEFAULT_INPUT_PROOF must be set together'
    )
  })
})
