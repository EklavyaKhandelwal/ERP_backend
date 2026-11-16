import 'dotenv/config';
import { z } from 'zod';

const optionalValue = z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional());
const timeZone = z.string().min(1).default('Asia/Kolkata').refine(value => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'COMPANY_TIME_ZONE must be a valid IANA timezone.');

const encryptionKey = z.string().refine(value => {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === 32 && decoded.toString('base64') === value;
}, 'Each field-encryption key must be a base64-encoded 32-byte key.');
const encryptionKeyring = z.preprocess(value => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}, z.object({
  activeKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  keys: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), encryptionKey),
}).superRefine((keyring, context) => {
  if (!(keyring.activeKeyId in keyring.keys)) {
    context.addIssue({
      code: 'custom',
      message: 'FIELD_ENCRYPTION_KEYRING.activeKeyId must be present in keys.',
    });
  }
}));

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL_CA_PATH: z.string().min(1, 'DATABASE_SSL_CA_PATH is required'),
  FIELD_ENCRYPTION_KEYRING: encryptionKeyring,
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  RESEND_API_KEY: optionalValue,
  RESEND_FROM_EMAIL: z.preprocess(value => value === '' ? undefined : value, z.string().email().optional()),
  APP_BASE_URL: z.preprocess(value => value === '' ? undefined : value, z.string().url().optional()),
  COMPANY_TIME_ZONE: timeZone,
});

export const env = envSchema.parse(process.env);
