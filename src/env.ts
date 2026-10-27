import 'dotenv/config';
import { z } from 'zod';

const optionalValue = z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional());

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  RESEND_API_KEY: optionalValue,
  RESEND_FROM_EMAIL: z.preprocess(value => value === '' ? undefined : value, z.string().email().optional()),
  APP_BASE_URL: z.preprocess(value => value === '' ? undefined : value, z.string().url().optional()),
});

export const env = envSchema.parse(process.env);
