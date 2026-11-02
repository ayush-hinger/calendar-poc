import crypto from 'node:crypto';
import { config } from './config.ts';

/**
 * Provider refresh tokens are long-lived keys to a student's real calendar, so
 * they are encrypted at rest rather than sitting in plaintext in the SQLite file.
 * AES-256-GCM; the IV and auth tag are stored alongside the ciphertext.
 */

const ALGO = 'aes-256-gcm';

function key(): Buffer | null {
  if (!config.ENCRYPTION_KEY) return null;
  return Buffer.from(config.ENCRYPTION_KEY, 'hex');
}

export function encrypt(plain: string | null | undefined): string | null {
  if (plain == null) return null;
  const k = key();
  // Without a key the POC still runs; tokens are stored with a marker so it is
  // obvious in the DB that they are not protected.
  if (!k) return `plain:${plain}`;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, k, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decrypt(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  if (stored.startsWith('plain:')) return stored.slice('plain:'.length);
  if (!stored.startsWith('v1:')) return stored;

  const k = key();
  if (!k) throw new Error('ENCRYPTION_KEY is required to read stored tokens');

  const [, ivB64, tagB64, ctB64] = stored.split(':');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted value');

  const decipher = crypto.createDecipheriv(ALGO, k, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

/** Stable per-target key, used as the Microsoft Graph transactionId. */
export function deterministicKey(...parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 36);
}
