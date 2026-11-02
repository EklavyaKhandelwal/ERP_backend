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

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  RESEND_API_KEY: optionalValue,
  RESEND_FROM_EMAIL: z.preprocess(value => value === '' ? undefined : value, z.string().email().optional()),
  APP_BASE_URL: z.preprocess(value => value === '' ? undefined : value, z.string().url().optional()),
  COMPANY_TIME_ZONE: timeZone,
});

export const env = envSchema.parse(process.env);
