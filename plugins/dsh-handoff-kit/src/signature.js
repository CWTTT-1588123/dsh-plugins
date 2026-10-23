/**
 * Opt-in Ed25519 detached signatures for handoff batches (P3/M5, decision D7).
 *
 * A signed batch carries one extra file — `signature.json` — that signs the
 * **bytes** of `SHA256SUMS`:
 *
 * ```json
 * {
 *   "alg": "ed25519",
 *   "keyId": "<sha256(publicKey PEM)[:16]>",
 *   "publicKey": "-----BEGIN PUBLIC KEY-----\n…",
 *   "signature": "<base64 detached signature>",
 *   "signedFile": "SHA256SUMS",
 *   "signedSha256": "<sha256(SHA256SUMS bytes)>",
 *   "createdAt": "2026-10-23T00:00:00.000Z"
 * }
 * ```
 *
 * Design constraints:
 *   - zero runtime dependencies: only `node:crypto` and `node:buffer`;
 *   - `signature.json` is **not** listed in `SHA256SUMS` (it signs the sums, so
 *     adding it would make signing change the batch hash semantics). It is
 *     also not a `manifest.artifacts` entry, so an unsigned batch and a signed
 *     batch verify identically except for the result-level `signature` status;
 *   - signing is write-once (`handoff-kit sign … [--force]`) and only ever
 *     writes `signature.json`;
 *   - the private key is passed explicitly on the CLI and never enters a
 *     manifest, tool output, session or batch.
 *
 * Verification states (never stored in findings unless `invalid`):
 *   - `unsigned` — no `signature.json` (not an error, trust unchanged);
 *   - `invalid`  — unparsable envelope, illegal field/algorithm, signature that
 *     does not verify, or `signedSha256` ≠ sha256(SHA256SUMS) → an
 *     `SIGNATURE_INVALID` **error finding** (trust becomes invalid);
 *   - `untrusted` — cryptographically valid, but the public key is not in the
 *     trust source (not an error, trust unchanged);
 *   - `valid`     — valid and the public key is trusted.
 *
 * Trust-source priority is decided by the caller: explicit `--pubkey` (CLI) or
 * `$DSH_HOME/handoff/trusted-keys.json` (read-only key list, same file for both
 * the tool and the CLI), otherwise a valid signature is `untrusted`.
 *
 * `keyId` is defined as the first 16 hex characters of
 * `sha256(<publicKey PEM text>)`, exactly as stored in the envelope (the PEM
 * emitted by {@link createSignatureEnvelope} is the canonical spki PEM).
 *
 * @module dsh-handoff-kit/signature
 */

import { Buffer } from 'node:buffer'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify
} from 'node:crypto'

import { ERROR, handoffError, isPlainObject } from './contracts.js'

/** Batch-relative file name of the signature envelope. */
export const SIGNATURE_FILE = 'signature.json'
/** User-level trusted-key list under the handoff root: `$DSH_HOME/handoff/trusted-keys.json`. */
export const TRUSTED_KEYS_FILE = 'trusted-keys.json'
/** The only signature algorithm this module emits/accepts. */
export const SIGNATURE_ALG = 'ed25519'
/** The only file this module signs. */
export const SIGNED_FILE = 'SHA256SUMS'

/** Number of hex characters in a `keyId`. */
const KEY_ID_LENGTH = 16
/** Raw Ed25519 signature length in bytes. */
const ED25519_SIGNATURE_BYTES = 64
const KEY_ID_RE = /^[0-9a-f]{16}$/
const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const ENVELOPE_FIELDS = Object.freeze([
  'alg',
  'keyId',
  'publicKey',
  'signature',
  'signedFile',
  'signedSha256',
  'createdAt'
])
const TRUSTED_KEY_FIELDS = Object.freeze(['keyId', 'publicKey', 'name'])

function misuse(detail) {
  return handoffError(ERROR.INTERNAL, detail)
}

/** Lower-case hex sha256 of a string or byte array (local; avoids an import cycle). */
function sha256Hex(input) {
  const hash = createHash('sha256')
  if (typeof input === 'string') hash.update(input, 'utf8')
  else hash.update(input)
  return hash.digest('hex')
}

/** Message from any thrown value (kept local to avoid a dependency on contracts helpers). */
function messageOf(error) {
  if (error instanceof Error && typeof error.message === 'string') return error.message
  return String(error)
}

/**
 * Derive the stable public-key identity used by the envelope.
 *
 * `keyId = sha256(publicKey PEM text)[:16]`; the PEM text is hashed exactly as
 * it appears (envelopes written by this module always contain the canonical
 * spki PEM produced by `KeyObject.export`).
 * @param {string} publicKeyPem public key in PEM (spki) form.
 * @returns {string} 16 lower-case hex characters.
 * @throws {Error & {code: string}} `HANDOFF_INTERNAL` for non-string input.
 */
export function computeKeyId(publicKeyPem) {
  if (typeof publicKeyPem !== 'string' || publicKeyPem.trim() === '')
    throw misuse('computeKeyId expects a public key PEM string')
  return sha256Hex(publicKeyPem).slice(0, KEY_ID_LENGTH)
}

/**
 * Parse a public-key PEM and return its trust-list entry.
 * @param {string} publicKeyPem public key in PEM form.
 * @returns {{keyId: string, publicKey: string}}
 * @throws {Error & {code: string}} `HANDOFF_INVALID_ARGS` when the PEM is unreadable.
 */
export function publicKeyEntry(publicKeyPem) {
  if (typeof publicKeyPem !== 'string' || publicKeyPem.trim() === '')
    throw handoffError(ERROR.INVALID_ARGS, 'public key must be a non-empty PEM string')
  try {
    createPublicKey({ key: publicKeyPem, format: 'pem' })
  } catch (error) {
    throw handoffError(
      ERROR.INVALID_ARGS,
      `public key is not a readable PEM public key: ${messageOf(error)}`
    )
  }
  return { keyId: computeKeyId(publicKeyPem), publicKey: publicKeyPem }
}

/** Canonical DER fingerprint of a PEM public key; used for tolerant trust matching. */
function publicKeyFingerprint(publicKeyPem) {
  const key = createPublicKey({ key: publicKeyPem, format: 'pem' })
  return sha256Hex(key.export({ type: 'spki', format: 'der' }))
}

/** Parse and validate an envelope field-by-field; throws with the invalid reason. */
function validateEnvelope(raw) {
  if (!isPlainObject(raw)) throw new Error('signature.json must contain a JSON object')
  for (const field of Object.keys(raw)) {
    if (!ENVELOPE_FIELDS.includes(field))
      throw new Error(`signature.json contains an unexpected field "${field}"`)
  }
  for (const field of ENVELOPE_FIELDS) {
    if (!(field in raw)) throw new Error(`signature.json is missing the "${field}" field`)
  }
  if (raw.alg !== SIGNATURE_ALG)
    throw new Error(`signature alg must be "${SIGNATURE_ALG}", got ${JSON.stringify(raw.alg)}`)
  if (raw.signedFile !== SIGNED_FILE)
    throw new Error(`signature signedFile must be "${SIGNED_FILE}", got ${JSON.stringify(raw.signedFile)}`)
  if (typeof raw.keyId !== 'string' || !KEY_ID_RE.test(raw.keyId))
    throw new Error('signature keyId must be 16 lower-case hex characters')
  if (typeof raw.publicKey !== 'string')
    throw new Error('signature publicKey must be a PEM string')
  publicKeyEntry(raw.publicKey)
  if (computeKeyId(raw.publicKey) !== raw.keyId)
    throw new Error('signature keyId does not match the embedded publicKey')
  if (typeof raw.signature !== 'string' || !BASE64_RE.test(raw.signature))
    throw new Error('signature signature must be a base64 string')
  if (Buffer.from(raw.signature, 'base64').length !== ED25519_SIGNATURE_BYTES)
    throw new Error('signature signature must decode to 64 Ed25519 bytes')
  if (typeof raw.signedSha256 !== 'string' || !SHA256_HEX_RE.test(raw.signedSha256))
    throw new Error('signature signedSha256 must be 64 lower-case hex characters')
  if (typeof raw.createdAt !== 'string' || raw.createdAt === '' || raw.createdAt.length > 64)
    throw new Error('signature createdAt must be a non-empty ISO timestamp string')
  return {
    alg: raw.alg,
    keyId: raw.keyId,
    publicKey: raw.publicKey,
    signature: raw.signature,
    signedFile: raw.signedFile,
    signedSha256: raw.signedSha256,
    createdAt: raw.createdAt
  }
}

/**
 * Create a detached Ed25519 signature envelope for the given `SHA256SUMS` bytes.
 *
 * The private key is used only inside this call: the returned envelope contains
 * the derived public key, never the private key.
 * @param {{sumsBytes: Uint8Array, privateKeyPem: string, createdAt: string}} input
 * @returns {{alg: 'ed25519', keyId: string, publicKey: string, signature: string,
 *   signedFile: 'SHA256SUMS', signedSha256: string, createdAt: string}}
 * @throws {Error & {code: string}} `HANDOFF_INVALID_ARGS` for an unusable key.
 */
export function createSignatureEnvelope({ sumsBytes, privateKeyPem, createdAt } = {}) {
  if (!(sumsBytes instanceof Uint8Array))
    throw handoffError(ERROR.INTERNAL, 'createSignatureEnvelope expects SHA256SUMS bytes')
  if (typeof privateKeyPem !== 'string' || privateKeyPem.trim() === '')
    throw handoffError(ERROR.INVALID_ARGS, 'a private key PEM is required to sign a batch')
  if (typeof createdAt !== 'string' || createdAt === '')
    throw handoffError(ERROR.INVALID_ARGS, 'a createdAt timestamp is required to sign a batch')

  let privateKey
  try {
    privateKey = createPrivateKey({ key: privateKeyPem, format: 'pem' })
  } catch (error) {
    throw handoffError(ERROR.INVALID_ARGS, `private key is not a readable PEM key: ${messageOf(error)}`)
  }
  if (privateKey.asymmetricKeyType !== 'ed25519')
    throw handoffError(
      ERROR.INVALID_ARGS,
      `private key must be an Ed25519 key (got ${String(privateKey.asymmetricKeyType)})`
    )
  let publicKey
  try {
    publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
  } catch (error) {
    throw handoffError(ERROR.INVALID_ARGS, `cannot derive the public key: ${messageOf(error)}`)
  }
  if (typeof publicKey !== 'string')
    throw handoffError(ERROR.INVALID_ARGS, 'cannot derive a PEM public key from the private key')

  const signatureBytes = cryptoSign(null, sumsBytes, privateKey)
  return {
    alg: SIGNATURE_ALG,
    keyId: computeKeyId(publicKey),
    publicKey,
    signature: Buffer.from(signatureBytes).toString('base64'),
    signedFile: SIGNED_FILE,
    signedSha256: sha256Hex(sumsBytes),
    createdAt
  }
}

/**
 * Parse a user-level trusted-key list.
 *
 * Shape: `{ "keys": [{ "keyId"?: "<16 hex>", "publicKey": "<PEM>", "name"?: "…" }] }`.
 * `keyId` may be omitted and is then computed from `publicKey`. Unknown fields
 * and unreadable public keys make the whole list invalid (the caller turns that
 * into an `untrusted` signature status, never `valid`).
 * @param {string} text raw JSON text of `trusted-keys.json`.
 * @returns {Array<{keyId: string, publicKey: string, name?: string}>}
 * @throws {Error & {code: string}} `HANDOFF_INVALID_ARGS` when the list is invalid.
 */
export function parseTrustedKeys(text) {
  let doc
  try {
    doc = JSON.parse(String(text))
  } catch (error) {
    throw handoffError(ERROR.INVALID_ARGS, `trusted-keys.json is not valid JSON: ${messageOf(error)}`)
  }
  if (!isPlainObject(doc))
    throw handoffError(ERROR.INVALID_ARGS, 'trusted-keys.json must contain a JSON object')
  for (const field of Object.keys(doc)) {
    if (field !== 'keys')
      throw handoffError(
        ERROR.INVALID_ARGS,
        `trusted-keys.json contains an unexpected field "${field}"`
      )
  }
  if (!Array.isArray(doc.keys))
    throw handoffError(ERROR.INVALID_ARGS, 'trusted-keys.json must contain a "keys" array')
  const entries = []
  const seen = new Set()
  for (const [index, raw] of doc.keys.entries()) {
    if (!isPlainObject(raw))
      throw handoffError(ERROR.INVALID_ARGS, `trusted-keys.json keys[${index}] must be an object`)
    for (const field of Object.keys(raw)) {
      if (!TRUSTED_KEY_FIELDS.includes(field))
        throw handoffError(
          ERROR.INVALID_ARGS,
          `trusted-keys.json keys[${index}] contains an unexpected field "${field}"`
        )
    }
    if (typeof raw.publicKey !== 'string' || raw.publicKey.trim() === '')
      throw handoffError(
        ERROR.INVALID_ARGS,
        `trusted-keys.json keys[${index}].publicKey must be a PEM string`
      )
    try {
      createPublicKey({ key: raw.publicKey, format: 'pem' })
    } catch (error) {
      throw handoffError(
        ERROR.INVALID_ARGS,
        `trusted-keys.json keys[${index}].publicKey is not a readable PEM public key: ${messageOf(error)}`
      )
    }
    const keyId = raw.keyId === undefined ? computeKeyId(raw.publicKey) : raw.keyId
    if (typeof keyId !== 'string' || !KEY_ID_RE.test(keyId))
      throw handoffError(
        ERROR.INVALID_ARGS,
        `trusted-keys.json keys[${index}].keyId must be 16 lower-case hex characters`
      )
    if (raw.name !== undefined && typeof raw.name !== 'string')
      throw handoffError(ERROR.INVALID_ARGS, `trusted-keys.json keys[${index}].name must be a string`)
    if (seen.has(keyId)) continue
    seen.add(keyId)
    entries.push({
      keyId,
      publicKey: raw.publicKey,
      ...(typeof raw.name === 'string' && raw.name !== '' ? { name: raw.name } : {})
    })
  }
  return entries
}

/**
 * Verify a detached signature envelope against `SHA256SUMS` and a trust list.
 *
 * Pure: the caller reads `signature.json`, `SHA256SUMS` and the trust source and
 * maps an `invalid` result onto an `SIGNATURE_INVALID` error finding.
 *
 * @param {{
 *   signatureText?: string|undefined,
 *   sumsBytes?: Uint8Array|undefined,
 *   trustedKeys?: Array<{keyId: string, publicKey: string}>,
 *   trustedKeysError?: string
 * }} input
 * @returns {{status: 'valid'|'untrusted'|'invalid'|'unsigned', keyId?: string, detail?: string}}
 */
export function evaluateSignature({
  signatureText,
  sumsBytes,
  trustedKeys = [],
  trustedKeysError
} = {}) {
  if (signatureText === undefined || signatureText === null) return { status: 'unsigned' }

  let raw
  try {
    raw = JSON.parse(String(signatureText))
  } catch (error) {
    return invalidSignature(`signature.json is not valid JSON: ${messageOf(error)}`)
  }
  let envelope
  try {
    envelope = validateEnvelope(raw)
  } catch (error) {
    return invalidSignature(`signature.json is invalid: ${messageOf(error)}`)
  }
  if (!(sumsBytes instanceof Uint8Array))
    return invalidSignature('SHA256SUMS is missing or unreadable, so the signed file cannot be checked')
  if (sha256Hex(sumsBytes) !== envelope.signedSha256)
    return invalidSignature('signedSha256 does not match the SHA256SUMS bytes in this batch')

  let verified = false
  try {
    const publicKey = createPublicKey({ key: envelope.publicKey, format: 'pem' })
    const signatureBytes = Buffer.from(envelope.signature, 'base64')
    verified = cryptoVerify(null, sumsBytes, publicKey, signatureBytes) === true
  } catch {
    verified = false
  }
  if (!verified)
    return invalidSignature(
      'the Ed25519 signature does not verify against the embedded public key'
    )

  const entries = Array.isArray(trustedKeys) ? trustedKeys.filter(isPlainObject) : []
  for (const entry of entries) {
    if (entry.keyId === envelope.keyId) return { status: 'valid', keyId: envelope.keyId }
  }
  // Tolerate trust-list PEMs with different formatting: compare key material.
  for (const entry of entries) {
    if (typeof entry.publicKey !== 'string') continue
    try {
      if (publicKeyFingerprint(entry.publicKey) === publicKeyFingerprint(envelope.publicKey))
        return { status: 'valid', keyId: envelope.keyId }
    } catch {
      /* an unreadable trust entry cannot establish trust */
    }
  }
  let detail = `signature is valid but public key ${envelope.keyId} is not in the trusted key set`
  if (typeof trustedKeysError === 'string' && trustedKeysError !== '')
    detail += ` (${trustedKeysError})`
  return { status: 'untrusted', keyId: envelope.keyId, detail }
}

/** Build an `invalid` evaluation result with a stable detail. */
function invalidSignature(detail) {
  return { status: 'invalid', detail }
}
