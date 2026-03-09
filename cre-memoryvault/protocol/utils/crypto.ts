/**
 * MemoryVault Agent Protocol — Cryptographic Utilities
 *
 * Shared helpers used by Memory Writer, Audit Reader, and Integrity Checker
 * protocol workflows.
 *
 * IMPORTANT CRE RUNTIME CONSTRAINTS:
 * - No `crypto` global (Web Crypto API not available in WASM)
 * - No `Bun.*` APIs (compiled to WASM, not Bun runtime)
 * - viem's `keccak256` IS available (used by CRE SDK internally)
 * - TextEncoder/TextDecoder ARE available
 *
 * For hashing, we use viem's keccak256 which is available in the CRE WASM
 * runtime. For encryption, we use a XOR-based simulation cipher since
 * Web Crypto is not available — production would use CRE's native crypto.
 *
 * @module protocol/utils/crypto
 */

// @ts-nocheck — REFERENCE MODULE ONLY. This file is never compiled directly.
// Its functions are inlined into each CRE workflow's main.ts, which has its
// own node_modules directory resolving viem. The CRE WASM compiler bundles
// per workflow directory, so cross-directory imports from protocol/utils/
// would fail at build time. This file is the canonical spec; update workflows
// when changing function signatures here.

import { keccak256, toHex } from 'viem'

// ═══════════════════════════════════════════════════════════════════════════
// Hashing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Keccak-256 hash of a string, returned as 0x-prefixed hex.
 *
 * Uses viem's keccak256 which is the only hash function available in
 * the CRE WASM runtime. This is the canonical hash used for all
 * MemoryVault entries — it matches Solidity's keccak256 natively,
 * enabling direct on-chain verification in MemoryRegistry without
 * any hash translation.
 *
 * Named keccak256Hash (not sha256) to accurately reflect the algorithm.
 *
 * @param data - The plaintext string to hash
 * @returns 0x-prefixed hex-encoded keccak256 hash (66 chars total)
 */
export function keccak256Hash(data: string): string {
    // Convert string → hex → keccak256
    // toHex converts the string to its UTF-8 hex representation
    return keccak256(toHex(data))
}

// ═══════════════════════════════════════════════════════════════════════════
// AES-GCM Encryption (Simulation)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Encrypt plaintext for MemoryVault storage.
 *
 * In CRE simulation, Web Crypto API (`crypto.subtle`) is NOT available
 * in the WASM runtime. This uses a XOR-based cipher for simulation
 * purposes. In production CRE deployment, this would be replaced with
 * real AES-GCM via the runtime's native crypto capabilities.
 *
 * The output format is: base64(IV_12bytes + XOR_ciphertext)
 * This maintains the same API contract as real AES-GCM (IV prepended).
 *
 * @param plaintext - The string to encrypt
 * @param keyHex - 64-char hex string (32 bytes = AES-256 key)
 * @returns Base64-encoded string
 */
export function aesGcmEncrypt(plaintext: string, keyHex: string): string {
    const keyBytes = hexToBytes(keyHex)
    if (keyBytes.length !== 32) {
        throw new Error(
            `AES-256 key must be 32 bytes (64 hex chars), got ${keyBytes.length} bytes`
        )
    }

    const encoded = new TextEncoder().encode(plaintext)

    // Generate a deterministic 12-byte "IV" from the plaintext hash
    // (In real AES-GCM, IV must be random. For simulation, this is acceptable.)
    const hashHex = keccak256(toHex(plaintext))
    const iv = hexToBytes(hashHex.slice(2, 26)) // first 12 bytes of hash

    // XOR plaintext with repeating key (simulation cipher)
    const ciphertext = new Uint8Array(encoded.length)
    for (let i = 0; i < encoded.length; i++) {
        ciphertext[i] = encoded[i] ^ keyBytes[i % keyBytes.length]
    }

    // Prepend IV to ciphertext (same layout as real AES-GCM)
    const combined = new Uint8Array(iv.length + ciphertext.length)
    combined.set(iv)
    combined.set(ciphertext, iv.length)

    return uint8ArrayToBase64(combined)
}

/**
 * Decrypt ciphertext from MemoryVault storage.
 *
 * Reverses the simulation cipher from aesGcmEncrypt.
 * Same API contract as real AES-GCM decryption.
 *
 * @param ciphertextB64 - Base64-encoded string from aesGcmEncrypt
 * @param keyHex - Same 64-char hex key used for encryption
 * @returns Decrypted plaintext string
 */
export function aesGcmDecrypt(ciphertextB64: string, keyHex: string): string {
    const combined = base64ToUint8Array(ciphertextB64)
    const _iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)

    const keyBytes = hexToBytes(keyHex)
    if (keyBytes.length !== 32) {
        throw new Error(
            `AES-256 key must be 32 bytes (64 hex chars), got ${keyBytes.length} bytes`
        )
    }

    // Reverse XOR cipher
    const plainBytes = new Uint8Array(ciphertext.length)
    for (let i = 0; i < ciphertext.length; i++) {
        plainBytes[i] = ciphertext[i] ^ keyBytes[i % keyBytes.length]
    }

    return new TextDecoder().decode(plainBytes)
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert hex string to Uint8Array. Strips optional 0x prefix.
 */
export function hexToBytes(hex: string): Uint8Array {
    const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex
    const bytes = new Uint8Array(cleanHex.length / 2)
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16)
    }
    return bytes
}

/**
 * Convert Uint8Array to base64 string.
 * Uses manual encoding since btoa may not be available in WASM.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let result = ''
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i]
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0

        result += chars[a >> 2]
        result += chars[((a & 3) << 4) | (b >> 4)]
        result += i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : '='
        result += i + 2 < bytes.length ? chars[c & 63] : '='
    }
    return result
}

/**
 * Convert base64 string to Uint8Array.
 * Uses manual decoding since atob may not be available in WASM.
 */
function base64ToUint8Array(b64: string): Uint8Array {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const lookup = new Map<string, number>()
    for (let i = 0; i < chars.length; i++) {
        lookup.set(chars[i], i)
    }

    // Remove padding
    const clean = b64.replace(/=/g, '')
    const byteLength = Math.floor((clean.length * 3) / 4)
    const bytes = new Uint8Array(byteLength)

    let j = 0
    for (let i = 0; i < clean.length; i += 4) {
        const a = lookup.get(clean[i]) || 0
        const b = lookup.get(clean[i + 1]) || 0
        const c = lookup.get(clean[i + 2]) || 0
        const d = lookup.get(clean[i + 3]) || 0

        bytes[j++] = (a << 2) | (b >> 4)
        if (j < byteLength) bytes[j++] = ((b & 15) << 4) | (c >> 2)
        if (j < byteLength) bytes[j++] = ((c & 3) << 6) | d
    }

    return bytes
}
