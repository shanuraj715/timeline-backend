import crypto from "crypto";

// AES-256-GCM for encrypting payment gateway secrets at rest. Each encrypt
// call uses a fresh random IV (never reused with the same key), and GCM's
// auth tag is stored alongside the ciphertext so tampering is detected on
// decrypt rather than silently producing garbage.

function getKey() {
  const hex = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!hex) throw new Error("Missing SETTINGS_ENCRYPTION_KEY environment variable.");
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("SETTINGS_ENCRYPTION_KEY must be a 32-byte (64 hex char) value.");
  return key;
}

/** Returns a single "iv:authTag:ciphertext" base64url string. */
export function encryptSecret(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("base64url")).join(":");
}

export function decryptSecret(encoded) {
  const [ivB64, authTagB64, ciphertextB64] = String(encoded).split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) throw new Error("Malformed encrypted value.");

  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64url")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Last 4 chars of a secret for display, e.g. "••••7f2a" — never returns the real value. */
export function maskSecret(plainText) {
  const str = String(plainText || "");
  if (str.length <= 4) return "••••";
  return `••••${str.slice(-4)}`;
}
