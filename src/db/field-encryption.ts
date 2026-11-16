import { env } from '../env.js';
import { createFieldEncryption } from './encryption-core.js';

export const fieldEncryption = createFieldEncryption(env.FIELD_ENCRYPTION_KEYRING);

export function decryptNumber(value: string, context: string): number {
  const number = Number(fieldEncryption.decryptText(value, context));
  if (!Number.isFinite(number)) {
    throw new Error('Decrypted numeric field is not a finite number.');
  }
  return number;
}

export function encryptNumber(value: number, context: string): string {
  if (!Number.isFinite(value)) throw new Error('Cannot encrypt a non-finite numeric field.');
  return fieldEncryption.encryptText(String(value), context);
}
