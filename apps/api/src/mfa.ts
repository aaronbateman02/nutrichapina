import { randomBytes, createHmac } from 'node:crypto';

// Minimal RFC 6238 TOTP (SHA-1, 30 s step, 6 digits). No external dependency;
// used for staff MFA enrollment/verification. Not a substitute for WebAuthn.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newSecret(bytes = 20): string {
  const raw = randomBytes(bytes);
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of raw) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function decodeBase32(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret: Buffer, counter: bigint): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const h = createHmac('sha1', secret).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  const code = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

function counterAt(timeMs: number): bigint {
  return BigInt(Math.floor(timeMs / 30_000));
}

export function totpNow(secret: string, timeMs: number = Date.now()): string {
  return hotp(decodeBase32(secret), counterAt(timeMs));
}

export function totpVerify(secret: string, token: string, timeMs: number = Date.now(), window = 1): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  let key: Buffer;
  try {
    key = decodeBase32(secret);
  } catch {
    return false;
  }
  const c = counterAt(timeMs);
  for (let d = -window; d <= window; d++) {
    if (hotp(key, c + BigInt(d)) === token) return true;
  }
  return false;
}

export function otpauthUrl(issuer: string, account: string, secret: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}
