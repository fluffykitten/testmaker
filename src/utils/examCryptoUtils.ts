/**
 * Cryptographic & Conflict Resolution Utilities for Air-Gapped Emergency Exam Packages (.exam)
 *
 * Uses the native W3C Web Crypto API (`crypto.subtle`) available in all modern browsers
 * and Node.js 20+ without external dependencies.
 *
 * Security Guarantees:
 * - AES-256-GCM authenticated encryption prevents students from reading or modifying
 *   raw answers, scores, or timestamps in a text editor.
 * - Additional Authenticated Data (AAD) binds the outer envelope metadata (`version`,
 *   `quizCode`, `candidateId`, `exportedAt`) to the GCM authentication tag, so altering
 *   any header field causes decryption to fail immediately.
 */

import type { StudentSubmission } from '../services/quizSubmissionService';

export const EMERGENCY_FORMAT_V2 = 'testmaker_emergency_v2' as const;
const KEY_DERIVATION_DOMAIN = 'TESTMAKER_EMERGENCY_V2_KEY::';
const KEY_DERIVATION_SALT = '::ICM_EXAM_SHIELD_SALT_2026';

export interface EmergencyPackageEnvelope {
  _format: typeof EMERGENCY_FORMAT_V2;
  version: 2;
  quizCode: string;
  candidateId: string;
  studentName: string;
  candidateNumber?: string;
  candidateClass?: string;
  exportedAt: string;
  iv: string;         // Base64 12-byte Initialization Vector
  ciphertext: string; // Base64 AES-256-GCM ciphertext + 128-bit auth tag
  checksum: string;   // SHA-256 hex digest of the canonical envelope fields
}

export interface ConflictResolutionDecision {
  action: 'insert' | 'update' | 'skip_older';
  winner: StudentSubmission;
  reason: string;
}

function getSubtleCrypto(): SubtleCrypto {
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error('Web Crypto API (crypto.subtle) is not available in this environment.');
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.trim();
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(clean, 'base64'));
  }
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Normalizes a quiz code for deterministic key derivation and comparison.
 */
export function normalizeEmergencyQuizCode(quizCode: string): string {
  return (quizCode || 'EXAM').trim().toUpperCase();
}

/**
 * Builds the Additional Authenticated Data (AAD) string bound to the AES-GCM tag.
 */
function buildEnvelopeAAD(params: {
  version: number;
  quizCode: string;
  candidateId: string;
  exportedAt: string;
}): Uint8Array {
  const canonical = `${params.version}|${normalizeEmergencyQuizCode(params.quizCode)}|${params.candidateId}|${params.exportedAt}`;
  return new TextEncoder().encode(canonical);
}

/**
 * Computes the SHA-256 hex checksum of the envelope header + iv + ciphertext.
 */
export async function computeEnvelopeChecksum(params: {
  version: number;
  quizCode: string;
  candidateId: string;
  exportedAt: string;
  iv: string;
  ciphertext: string;
}): Promise<string> {
  const subtle = getSubtleCrypto();
  const canonical = [
    params.version,
    normalizeEmergencyQuizCode(params.quizCode),
    params.candidateId,
    params.exportedAt,
    params.iv,
    params.ciphertext,
  ].join('|');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Derives a deterministic 256-bit AES-GCM CryptoKey from the assessment quiz code.
 */
export async function deriveExamKey(quizCode: string): Promise<CryptoKey> {
  const subtle = getSubtleCrypto();
  const normalizedCode = normalizeEmergencyQuizCode(quizCode);
  const seedBytes = new TextEncoder().encode(
    `${KEY_DERIVATION_DOMAIN}${normalizedCode}${KEY_DERIVATION_SALT}`
  );
  const rawKeyMaterial = await subtle.digest('SHA-256', seedBytes);
  return subtle.importKey(
    'raw',
    rawKeyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Validates that a parsed JSON object conforms to the v2 emergency envelope schema.
 */
export function validateEmergencyEnvelope(obj: unknown): obj is EmergencyPackageEnvelope {
  if (!obj || typeof obj !== 'object') return false;
  const env = obj as Record<string, unknown>;
  return (
    env._format === EMERGENCY_FORMAT_V2 &&
    env.version === 2 &&
    typeof env.quizCode === 'string' &&
    env.quizCode.trim().length > 0 &&
    typeof env.candidateId === 'string' &&
    env.candidateId.trim().length > 0 &&
    typeof env.studentName === 'string' &&
    typeof env.exportedAt === 'string' &&
    typeof env.iv === 'string' &&
    env.iv.length > 0 &&
    typeof env.ciphertext === 'string' &&
    env.ciphertext.length > 0 &&
    typeof env.checksum === 'string' &&
    env.checksum.length === 64
  );
}

/**
 * Encrypts a StudentSubmission into a tamper-evident AES-256-GCM `.exam` JSON envelope string.
 */
export async function encryptEmergencyPackage(
  quizCode: string,
  submission: StudentSubmission,
  exportedAtOverride?: string
): Promise<{ envelope: EmergencyPackageEnvelope; serialized: string }> {
  const subtle = getSubtleCrypto();
  const normalizedCode = normalizeEmergencyQuizCode(quizCode || submission.quizCode);
  const key = await deriveExamKey(normalizedCode);

  const ivBytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(ivBytes);

  const exportedAt = exportedAtOverride || new Date().toISOString();
  const candidateId =
    submission.forensics?.proctorStudentId ||
    `cand_${(submission.studentName || 'candidate').trim().toLowerCase().replace(/\s+/g, '_')}`;

  const aad = buildEnvelopeAAD({
    version: 2,
    quizCode: normalizedCode,
    candidateId,
    exportedAt,
  });

  const payloadToEncrypt: StudentSubmission = {
    ...submission,
    quizCode: normalizedCode,
  };

  const plaintextBytes = new TextEncoder().encode(JSON.stringify(payloadToEncrypt));
  const encryptedBuffer = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes as BufferSource,
      additionalData: aad as BufferSource,
      tagLength: 128,
    },
    key,
    plaintextBytes as BufferSource
  );

  const ivBase64 = bytesToBase64(ivBytes);
  const ciphertextBase64 = bytesToBase64(new Uint8Array(encryptedBuffer));

  const checksum = await computeEnvelopeChecksum({
    version: 2,
    quizCode: normalizedCode,
    candidateId,
    exportedAt,
    iv: ivBase64,
    ciphertext: ciphertextBase64,
  });

  const envelope: EmergencyPackageEnvelope = {
    _format: EMERGENCY_FORMAT_V2,
    version: 2,
    quizCode: normalizedCode,
    candidateId,
    studentName: submission.studentName || 'Candidate',
    candidateNumber: submission.candidateNumber,
    candidateClass: submission.studentClass,
    exportedAt,
    iv: ivBase64,
    ciphertext: ciphertextBase64,
    checksum,
  };

  return {
    envelope,
    serialized: JSON.stringify(envelope, null, 2),
  };
}

/**
 * Decrypts and authenticates an AES-256-GCM `.exam` envelope string.
 * Throws descriptive errors if the checksum, AAD, quizCode, or GCM authentication tag fails.
 */
export async function decryptEmergencyPackage(
  expectedQuizCode: string | undefined,
  envelopeJsonOrObject: string | EmergencyPackageEnvelope
): Promise<StudentSubmission> {
  const subtle = getSubtleCrypto();

  let parsed: unknown;
  if (typeof envelopeJsonOrObject === 'string') {
    try {
      parsed = JSON.parse(envelopeJsonOrObject.trim());
    } catch {
      throw new Error('Malformed emergency file: invalid JSON syntax.');
    }
  } else {
    parsed = envelopeJsonOrObject;
  }

  if (!validateEmergencyEnvelope(parsed)) {
    throw new Error('Invalid emergency package schema or missing cryptographic fields.');
  }

  const envelopeQuizCode = normalizeEmergencyQuizCode(parsed.quizCode);
  if (expectedQuizCode && normalizeEmergencyQuizCode(expectedQuizCode) !== envelopeQuizCode) {
    throw new Error(
      `Quiz code mismatch: file belongs to exam "${envelopeQuizCode}", but target exam is "${normalizeEmergencyQuizCode(expectedQuizCode)}".`
    );
  }

  // 1. Verify outer SHA-256 checksum
  const expectedChecksum = await computeEnvelopeChecksum({
    version: parsed.version,
    quizCode: envelopeQuizCode,
    candidateId: parsed.candidateId,
    exportedAt: parsed.exportedAt,
    iv: parsed.iv,
    ciphertext: parsed.ciphertext,
  });

  if (expectedChecksum !== parsed.checksum) {
    throw new Error('Tamper detected: emergency file checksum verification failed.');
  }

  // 2. Derive key and decrypt with AES-GCM + AAD verification
  const key = await deriveExamKey(envelopeQuizCode);
  const ivBytes = base64ToBytes(parsed.iv);
  const ciphertextBytes = base64ToBytes(parsed.ciphertext);

  if (ivBytes.byteLength !== 12) {
    throw new Error('Invalid emergency package initialization vector.');
  }

  const aad = buildEnvelopeAAD({
    version: parsed.version,
    quizCode: envelopeQuizCode,
    candidateId: parsed.candidateId,
    exportedAt: parsed.exportedAt,
  });

  let decryptedBuffer: ArrayBuffer;
  try {
    decryptedBuffer = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes as BufferSource,
        additionalData: aad as BufferSource,
        tagLength: 128,
      },
      key,
      ciphertextBytes as BufferSource
    );
  } catch {
    throw new Error('Tamper detected: AES-GCM authentication tag verification failed.');
  }

  const decodedText = new TextDecoder().decode(decryptedBuffer);
  const submission = JSON.parse(decodedText) as StudentSubmission;

  if (!submission || !submission.id || !submission.studentName || !submission.quizCode) {
    throw new Error('Decrypted payload is missing required student submission fields.');
  }

  return submission;
}

/**
 * Formats a clean, cross-platform filename for an emergency `.exam` file:
 * `[QuizCode]_[CandidateName]_[Timestamp].exam`
 */
export function formatEmergencyExamFileName(submission: StudentSubmission): string {
  const cleanCode = normalizeEmergencyQuizCode(submission.quizCode).replace(/[^A-Z0-9_-]/g, '_');
  const rawCandidate = submission.candidateNumber
    ? `${submission.studentName || 'Candidate'}_${submission.candidateNumber}`
    : submission.studentName || 'Candidate';
  const cleanStudent = rawCandidate
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'Candidate';

  const d = submission.submittedAt ? new Date(submission.submittedAt) : new Date();
  const validDate = Number.isNaN(d.getTime()) ? new Date() : d;
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${validDate.getUTCFullYear()}${pad(validDate.getUTCMonth() + 1)}${pad(validDate.getUTCDate())}-${pad(validDate.getUTCHours())}${pad(validDate.getUTCMinutes())}`;

  return `${cleanCode}_${cleanStudent}_${ts}.exam`;
}

/**
 * Resolves conflicts when a candidate has both an existing submission in the cloud/local store
 * and an incoming emergency offline `.exam` submission.
 *
 * Policy: Newest Timestamp Wins + Audit Flag.
 * - If no existing record exists -> 'insert'.
 * - If incoming timestamp is newer than (or equal to) existing timestamp -> 'update' (replaces with incoming,
 *   retaining the existing record `id` to avoid duplicate rows, and preserving teacher adjustments if already graded).
 * - If existing timestamp is strictly newer -> 'skip_older' (preserves the newer existing cloud record).
 */
export function resolveEmergencySubmissionConflict(
  existing: StudentSubmission | undefined,
  incoming: StudentSubmission,
  ingestedAtIso: string = new Date().toISOString()
): ConflictResolutionDecision {
  const stampedIncoming: StudentSubmission = {
    ...incoming,
    forensics: {
      ...(incoming.forensics || {}),
      ingestionSource: 'emergency_offline',
      ingestedAt: ingestedAtIso,
    },
  };

  if (!existing) {
    return {
      action: 'insert',
      winner: stampedIncoming,
      reason: 'New candidate submission ingested from emergency package.',
    };
  }

  const existingMs = Date.parse(existing.submittedAt || '');
  const incomingMs = Date.parse(incoming.submittedAt || '');

  // If existing has a valid timestamp that is strictly newer than incoming, preserve existing
  if (!Number.isNaN(existingMs) && !Number.isNaN(incomingMs) && existingMs > incomingMs) {
    return {
      action: 'skip_older',
      winner: existing,
      reason: `Existing cloud record (${existing.submittedAt}) is newer than offline file (${incoming.submittedAt}).`,
    };
  }

  // Incoming is newer (or timestamps equal/invalid): update existing record in-place
  const mergedWinner: StudentSubmission = {
    ...stampedIncoming,
    // Keep the existing canonical submission ID so database upsert updates the same row
    id: existing.id || stampedIncoming.id,
    teacherAdjustedMarks: existing.teacherAdjustedMarks ?? stampedIncoming.teacherAdjustedMarks,
    teacherNotes: existing.teacherNotes ?? stampedIncoming.teacherNotes,
    updatedAt: ingestedAtIso,
  };

  return {
    action: 'update',
    winner: mergedWinner,
    reason: `Offline file (${incoming.submittedAt}) is newer than existing record (${existing.submittedAt}).`,
  };
}
