import type { Hex } from 'viem'

export interface EncryptedInputPayload {
  handle: Hex
  inputProof: Hex
}

export type EncryptedInputPayloadMap = Record<string, EncryptedInputPayload>

export function parseEncryptedInputPayloadMap(raw: string | undefined): EncryptedInputPayloadMap {
  if (!raw || !raw.trim()) {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Invalid ZAMA_ENCRYPTED_INPUTS_JSON: expected valid JSON object')
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid ZAMA_ENCRYPTED_INPUTS_JSON: expected object keyed by amount string')
  }

  const mapped: EncryptedInputPayloadMap = {}
  for (const [amountKey, value] of Object.entries(parsed)) {
    if (!/^\d+$/.test(amountKey)) {
      throw new Error(`Invalid encrypted input amount key: ${amountKey}`)
    }
    mapped[amountKey] = parsePayload(value, `ZAMA_ENCRYPTED_INPUTS_JSON.${amountKey}`)
  }

  return mapped
}

export function parseDefaultEncryptedInputPayload(
  handle: string | undefined,
  inputProof: string | undefined
): EncryptedInputPayload | undefined {
  const hasHandle = Boolean(handle && handle.trim())
  const hasProof = Boolean(inputProof && inputProof.trim())

  if (!hasHandle && !hasProof) {
    return undefined
  }

  if (!hasHandle || !hasProof) {
    throw new Error('ZAMA_DEFAULT_HANDLE and ZAMA_DEFAULT_INPUT_PROOF must be set together')
  }

  return parsePayload(
    {
      handle,
      inputProof,
    },
    'ZAMA_DEFAULT_*'
  )
}

export function resolveEncryptedInputPayload(args: {
  amount: bigint
  mapping: EncryptedInputPayloadMap
  defaultPayload?: EncryptedInputPayload
}): EncryptedInputPayload {
  const amountKey = args.amount.toString()
  const exact = args.mapping[amountKey]
  if (exact) {
    return exact
  }

  if (args.defaultPayload) {
    return args.defaultPayload
  }

  throw new Error(
    `Missing encrypted payload for amount=${amountKey}. Add it to ZAMA_ENCRYPTED_INPUTS_JSON or set ZAMA_DEFAULT_*`
  )
}

function parsePayload(raw: unknown, label: string): EncryptedInputPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid ${label}: expected object with { handle, inputProof }`)
  }

  const handle = (raw as Record<string, unknown>).handle
  const inputProof = (raw as Record<string, unknown>).inputProof

  if (!isHexString(handle) || handle.length !== 66) {
    throw new Error(`Invalid ${label}.handle: expected 32-byte hex (bytes32)`)
  }

  if (!isHexString(inputProof)) {
    throw new Error(`Invalid ${label}.inputProof: expected hex string`)
  }

  return {
    handle: handle as Hex,
    inputProof: inputProof as Hex,
  }
}

function isHexString(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)
}
