/**
 * Pure WebCrypto ECDSA P-256 signing & verification for live proctor commands.
 *
 * Teacher clients hold an ephemeral non-extractable private key in tab memory and
 * publish only the public JWK via `register_proctor_public_key`. Student clients
 * fetch public JWKs via `get_proctor_public_key` and reject forged or stale
 * broadcasts on `exam_proctor:<CODE>`.
 */

export const MAX_PROCTOR_COMMAND_AGE_MS = 5 * 60 * 1000;

export interface SignableProctorCommandFields {
  id: string;
  type: string;
  quizCode?: string;
  targetStudentId: string;
  targetClass?: string;
  minutes?: number;
  message?: string;
  issuedAt?: number;
  keyId?: string;
  sig?: string;
}

export interface ProctorSigningSession {
  keyId: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}

export interface PublicKeyLookupResult {
  found: boolean;
  publicJwk?: JsonWebKey;
  rpcUnavailable?: boolean;
}

export type PublicKeyResolver = (
  quizCode: string,
  keyId: string
) => Promise<PublicKeyLookupResult>;

function getSubtleCrypto(): SubtleCrypto | null {
  return typeof globalThis !== 'undefined' && globalThis.crypto?.subtle
    ? globalThis.crypto.subtle
    : null;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/** Canonical deterministic JSON representation signed/verified across hosts and students. */
export function canonicalizeProctorCommand(cmd: SignableProctorCommandFields): string {
  return JSON.stringify({
    id: String(cmd.id || ''),
    type: String(cmd.type || ''),
    quizCode: String(cmd.quizCode || '').trim().toUpperCase(),
    targetStudentId: String(cmd.targetStudentId || ''),
    targetClass: String(cmd.targetClass || '').trim(),
    minutes: typeof cmd.minutes === 'number' && Number.isFinite(cmd.minutes) ? cmd.minutes : null,
    message: String(cmd.message || ''),
    issuedAt: Number(cmd.issuedAt || 0),
    keyId: String(cmd.keyId || ''),
  });
}

/** Generates an ephemeral non-extractable ECDSA P-256 signing session for an invigilator tab. */
export async function generateProctorSigningSession(): Promise<ProctorSigningSession | null> {
  const subtle = getSubtleCrypto();
  if (!subtle) return null;

  const pair = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify']
  );
  const fullJwk = await subtle.exportKey('jwk', pair.publicKey);
  const publicJwk: JsonWebKey = {
    kty: fullJwk.kty,
    crv: fullJwk.crv,
    x: fullJwk.x,
    y: fullJwk.y,
    ext: true,
  };
  const randHex = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return {
    keyId: `pk_${Date.now().toString(36)}_${randHex}`,
    privateKey: pair.privateKey,
    publicJwk,
  };
}

/** Signs a proctor command payload with ECDSA P-256 + SHA-256. */
export async function signProctorCommand<T extends SignableProctorCommandFields>(
  session: ProctorSigningSession,
  cmd: T,
  nowMs = Date.now()
): Promise<T & { quizCode: string; issuedAt: number; keyId: string; sig: string }> {
  const subtle = getSubtleCrypto();
  if (!subtle) {
    throw new Error('WebCrypto subtle API unavailable for proctor command signing');
  }

  const normalized = {
    ...cmd,
    quizCode: String(cmd.quizCode || '').trim().toUpperCase(),
    issuedAt: nowMs,
    keyId: session.keyId,
  };
  const encoded = new TextEncoder().encode(canonicalizeProctorCommand(normalized));
  const rawSig = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    session.privateKey,
    encoded
  );

  return {
    ...normalized,
    sig: bytesToBase64(new Uint8Array(rawSig)),
  };
}

export interface CommandVerifyResult {
  status: 'valid' | 'invalid' | 'legacy_fallback';
  reason?: string;
}

/**
 * Verifies an incoming `proctor_cmd` frame.
 * Returns `legacy_fallback` ONLY when Migration 023 RPC (`get_proctor_public_key`) is not deployed
 * AND the frame carries no signature; once 023 is deployed, unsigned/forged commands return `invalid`.
 */
export async function verifyProctorCommandSignature(
  cmd: SignableProctorCommandFields,
  expectedQuizCode: string,
  resolvePublicKey: PublicKeyResolver,
  nowMs = Date.now()
): Promise<CommandVerifyResult> {
  const cleanExpectedCode = expectedQuizCode.trim().toUpperCase();
  const cmdCode = String(cmd.quizCode || cleanExpectedCode).trim().toUpperCase();
  if (cleanExpectedCode && cmdCode !== cleanExpectedCode) {
    return { status: 'invalid', reason: 'quiz_code_mismatch' };
  }

  const hasSig = Boolean(cmd.sig && cmd.keyId);
  if (!hasSig) {
    const probe = await resolvePublicKey(cleanExpectedCode, '__legacy_probe__');
    if (probe.rpcUnavailable) {
      return { status: 'legacy_fallback', reason: 'rpc_not_deployed' };
    }
    return { status: 'invalid', reason: 'missing_signature' };
  }

  const issuedAt = Number(cmd.issuedAt);
  if (!Number.isFinite(issuedAt) || Math.abs(nowMs - issuedAt) > MAX_PROCTOR_COMMAND_AGE_MS) {
    return { status: 'invalid', reason: 'stale_or_missing_timestamp' };
  }

  const subtle = getSubtleCrypto();
  if (!subtle) {
    return { status: 'invalid', reason: 'webcrypto_unavailable' };
  }

  const lookup = await resolvePublicKey(cmdCode, cmd.keyId!);
  if (lookup.rpcUnavailable) {
    return { status: 'invalid', reason: 'key_lookup_rpc_unavailable' };
  }
  if (!lookup.found || !lookup.publicJwk) {
    return { status: 'invalid', reason: 'unknown_or_expired_key' };
  }

  try {
    const verifyKey = await subtle.importKey(
      'jwk',
      lookup.publicJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const payloadBytes = new TextEncoder().encode(
      canonicalizeProctorCommand({ ...cmd, quizCode: cmdCode })
    );
    const sigBytes = base64ToBytes(cmd.sig!);
    const ok = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      sigBytes as BufferSource,
      payloadBytes as BufferSource
    );
    return ok ? { status: 'valid' } : { status: 'invalid', reason: 'bad_signature' };
  } catch {
    return { status: 'invalid', reason: 'verification_exception' };
  }
}

function stableNormalizeValue(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(stableNormalizeValue);
  }
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(val as Record<string, unknown>).sort()) {
      const v = (val as Record<string, unknown>)[k];
      if (v !== undefined) {
        out[k] = stableNormalizeValue(v);
      }
    }
    return out;
  }
  return val;
}

/** Canonical deterministic JSON representation for signed Live Game host broadcasts (`VULN-P3-08`). */
export function canonicalizeGameBroadcastFrame(frame: Record<string, unknown>): string {
  const { sig: _ignoredSig, ...rest } = frame;
  return JSON.stringify(stableNormalizeValue({
    ...rest,
    quizCode: String(rest.quizCode || '').trim().toUpperCase(),
    issuedAt: Number(rest.issuedAt || 0),
    keyId: String(rest.keyId || ''),
  }));
}

/** Signs a Live Game host broadcast frame with the host's ECDSA P-256 ephemeral private key. */
export async function signGameBroadcastFrame<T extends Record<string, unknown>>(
  session: ProctorSigningSession,
  quizCode: string,
  frame: T,
  nowMs = Date.now()
): Promise<T & { quizCode: string; issuedAt: number; keyId: string; sig: string }> {
  const subtle = getSubtleCrypto();
  if (!subtle) {
    throw new Error('WebCrypto subtle API unavailable for game broadcast signing');
  }

  const normalized = {
    ...frame,
    quizCode: String(quizCode || '').trim().toUpperCase(),
    issuedAt: nowMs,
    keyId: session.keyId,
  };
  const encoded = new TextEncoder().encode(canonicalizeGameBroadcastFrame(normalized));
  const rawSig = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    session.privateKey,
    encoded
  );

  return {
    ...normalized,
    sig: bytesToBase64(new Uint8Array(rawSig)),
  };
}

/** Verifies an incoming Live Game host broadcast frame (`game_start`, `question_start`, etc.). */
export async function verifyGameBroadcastFrame(
  frame: Record<string, unknown> | null | undefined,
  expectedQuizCode: string,
  resolvePublicKey: PublicKeyResolver,
  nowMs = Date.now()
): Promise<CommandVerifyResult> {
  if (!frame || typeof frame !== 'object') {
    return { status: 'invalid', reason: 'malformed_frame' };
  }

  const cleanExpectedCode = expectedQuizCode.trim().toUpperCase();
  const frameCode = String(frame.quizCode || cleanExpectedCode).trim().toUpperCase();
  if (cleanExpectedCode && frameCode !== cleanExpectedCode) {
    return { status: 'invalid', reason: 'quiz_code_mismatch' };
  }

  const sig = typeof frame.sig === 'string' ? frame.sig : '';
  const keyId = typeof frame.keyId === 'string' ? frame.keyId : '';
  if (!sig || !keyId) {
    const probe = await resolvePublicKey(cleanExpectedCode, '__legacy_probe__');
    if (probe.rpcUnavailable) {
      return { status: 'legacy_fallback', reason: 'rpc_not_deployed' };
    }
    return { status: 'invalid', reason: 'missing_signature' };
  }

  const issuedAt = Number(frame.issuedAt);
  if (!Number.isFinite(issuedAt) || Math.abs(nowMs - issuedAt) > MAX_PROCTOR_COMMAND_AGE_MS) {
    return { status: 'invalid', reason: 'stale_or_missing_timestamp' };
  }

  const subtle = getSubtleCrypto();
  if (!subtle) {
    return { status: 'invalid', reason: 'webcrypto_unavailable' };
  }

  const lookup = await resolvePublicKey(frameCode, keyId);
  if (lookup.rpcUnavailable) {
    return { status: 'invalid', reason: 'key_lookup_rpc_unavailable' };
  }
  if (!lookup.found || !lookup.publicJwk) {
    return { status: 'invalid', reason: 'unknown_or_expired_key' };
  }

  try {
    const verifyKey = await subtle.importKey(
      'jwk',
      lookup.publicJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const payloadBytes = new TextEncoder().encode(
      canonicalizeGameBroadcastFrame({ ...frame, quizCode: frameCode })
    );
    const ok = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      base64ToBytes(sig) as BufferSource,
      payloadBytes as BufferSource
    );
    return ok ? { status: 'valid' } : { status: 'invalid', reason: 'bad_signature' };
  } catch {
    return { status: 'invalid', reason: 'verification_exception' };
  }
}

