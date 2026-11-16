import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: {
    ca: readFileSync(env.DATABASE_SSL_CA_PATH, 'utf8'),
    rejectUnauthorized: true,
  },
});

export const db = drizzle(pool, { schema });
