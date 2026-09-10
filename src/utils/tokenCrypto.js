'use strict';

/**
 * Application-level encryption for OAuth tokens at rest (AES-256-GCM).
 *
 * The database only ever sees ciphertext; the key lives in the runtime environment
 * (TOKEN_ENCRYPTION_KEY, 32 random bytes, base64 — `openssl rand -base64 32`).
 *
 * Format: `enc:v1:<iv>:<tag>:<ciphertext>` (all base64url). The prefix makes legacy plaintext rows
 * recognisable so they can be re-encrypted lazily, and leaves room for a v2.
 *
 * Rotation: set TOKEN_ENCRYPTION_KEY to the new key and TOKEN_ENCRYPTION_KEY_PREVIOUS to the old one;
 * reads try the current key first and fall back to the previous one, writes always use the current
 * key. Once every row has been rewritten (a restart re-encrypts on load), drop the previous key.
 */

const crypto = require('crypto');

const PREFIX = 'enc:v1:';

class TokenCrypto {
  /**
   * @param {string} keyB64            current key, 32 bytes base64/base64url
   * @param {string|null} [prevKeyB64] previous key, accepted for decryption only
   */
  constructor(keyB64, prevKeyB64 = null) {
    this.key = TokenCrypto._parseKey(keyB64, 'TOKEN_ENCRYPTION_KEY');
    this.prevKey = prevKeyB64 ? TokenCrypto._parseKey(prevKeyB64, 'TOKEN_ENCRYPTION_KEY_PREVIOUS') : null;
  }

  static _parseKey(b64, name) {
    const buf = Buffer.from(String(b64 || '').trim(), 'base64');
    if (buf.length !== 32) throw new Error(`${name} must be 32 random bytes, base64-encoded (openssl rand -base64 32)`);
    return buf;
  }

  /** @returns {TokenCrypto|null} null when no key is configured (local dev without a database) */
  static fromEnv(env = process.env) {
    if (!env.TOKEN_ENCRYPTION_KEY) return null;
    return new TokenCrypto(env.TOKEN_ENCRYPTION_KEY, env.TOKEN_ENCRYPTION_KEY_PREVIOUS || null);
  }

  static isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
  }

  /** @param {string} plaintext @returns {string} `enc:v1:iv:tag:data` */
  encrypt(plaintext) {
    if (plaintext === null || plaintext === undefined) return plaintext;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + [iv, tag, data].map((b) => b.toString('base64url')).join(':');
  }

  /**
   * Decrypt an `enc:v1:` value. Plaintext (legacy rows) is returned unchanged so callers can migrate
   * lazily. Tampered or wrong-key ciphertext throws.
   * @param {string} value
   * @returns {string}
   */
  decrypt(value) {
    if (!TokenCrypto.isEncrypted(value)) return value;
    const parts = value.slice(PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('Malformed encrypted token');
    const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64url'));
    const keys = this.prevKey ? [this.key, this.prevKey] : [this.key];
    let lastErr;
    for (const key of keys) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      } catch (err) { lastErr = err; }
    }
    throw new Error(`Could not decrypt token (wrong TOKEN_ENCRYPTION_KEY or tampered value): ${lastErr?.message || 'auth failed'}`);
  }

  /** True when the value is encrypted with the *current* key (i.e. needs no rewrite after rotation). */
  isCurrent(value) {
    if (!TokenCrypto.isEncrypted(value)) return false;
    try {
      const [iv, tag, data] = value.slice(PREFIX.length).split(':').map((p) => Buffer.from(p, 'base64url'));
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv); d.setAuthTag(tag); d.update(data); d.final();
      return true;
    } catch { return false; }
  }
}

module.exports = { TokenCrypto, PREFIX };
