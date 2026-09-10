'use strict';

const crypto = require('crypto');
const { TokenCrypto, PREFIX } = require('../src/utils/tokenCrypto');

const key = () => crypto.randomBytes(32).toString('base64');

describe('TokenCrypto', () => {
  test('round trip; ciphertext is prefixed, random per call, and never contains the plaintext', () => {
    const tc = new TokenCrypto(key());
    const a = tc.encrypt('secret-access-token');
    const b = tc.encrypt('secret-access-token');
    expect(a.startsWith(PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain('secret-access-token');
    expect(tc.decrypt(a)).toBe('secret-access-token');
    expect(TokenCrypto.isEncrypted(a)).toBe(true);
    expect(tc.isCurrent(a)).toBe(true);
  });

  test('legacy plaintext passes through decrypt unchanged (lazy migration)', () => {
    const tc = new TokenCrypto(key());
    expect(tc.decrypt('plain-old-token')).toBe('plain-old-token');
    expect(TokenCrypto.isEncrypted('plain-old-token')).toBe(false);
    expect(tc.isCurrent('plain-old-token')).toBe(false);
  });

  test('wrong key or tampering is detected, never silently returns garbage', () => {
    const enc = new TokenCrypto(key()).encrypt('t');
    expect(() => new TokenCrypto(key()).decrypt(enc)).toThrow(/wrong TOKEN_ENCRYPTION_KEY or tampered/);
    const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'BB' : 'AA');
    expect(() => new TokenCrypto(key()).decrypt(tampered)).toThrow();
    expect(() => new TokenCrypto(key()).decrypt(`${PREFIX}not:enough`)).toThrow(/Malformed/);
  });

  test('rotation: previous key decrypts, current key encrypts, isCurrent tells them apart', () => {
    const oldK = key(); const newK = key();
    const oldTc = new TokenCrypto(oldK);
    const rotated = new TokenCrypto(newK, oldK);
    const encOld = oldTc.encrypt('rt');
    expect(rotated.decrypt(encOld)).toBe('rt');
    expect(rotated.isCurrent(encOld)).toBe(false);
    const encNew = rotated.encrypt('rt');
    expect(rotated.isCurrent(encNew)).toBe(true);
    expect(() => new TokenCrypto(newK).decrypt(encOld)).toThrow();
  });

  test('fromEnv: null without a key; bad key length rejected with a clear message', () => {
    expect(TokenCrypto.fromEnv({})).toBeNull();
    expect(TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: key() })).toBeInstanceOf(TokenCrypto);
    expect(() => TokenCrypto.fromEnv({ TOKEN_ENCRYPTION_KEY: 'too-short' })).toThrow(/32 random bytes/);
  });
});
