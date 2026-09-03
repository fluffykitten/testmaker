/**
 * Cryptographic utility functions for secure hashing and validation
 * using the browser's native Web Crypto API.
 */

/**
 * Generates a SHA-256 lowercase hex string from an input string.
 */
export async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validates a user-entered PIN against a stored target value.
 * Supports:
 * 1. 64-character SHA-256 hex hash (modern secure storage)
 * 2. Plaintext legacy PIN (backward compatibility with existing databases)
 */
export async function verifyPinAgainstHashOrPlain(
  enteredPin: string,
  storedValue: string
): Promise<boolean> {
  if (!enteredPin || !storedValue) return false;

  const normalizedEntered = enteredPin.trim();
  const normalizedStored = storedValue.trim();

  // 1. If stored value is already a 64-character SHA-256 hex hash
  if (normalizedStored.length === 64 && /^[0-9a-fA-F]{64}$/.test(normalizedStored)) {
    const hashedEntered = await sha256Hex(normalizedEntered);
    return hashedEntered.toLowerCase() === normalizedStored.toLowerCase();
  }

  // 2. Legacy plaintext match
  if (normalizedEntered === normalizedStored) {
    return true;
  }

  // 3. Fallback hash comparison
  const hashedEntered = await sha256Hex(normalizedEntered);
  return hashedEntered.toLowerCase() === normalizedStored.toLowerCase();
}
