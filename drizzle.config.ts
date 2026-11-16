import { readFileSync } from 'node:fs';
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const databaseUrlValue = process.env.DATABASE_URL;
if (!databaseUrlValue) {
  throw new Error('DATABASE_URL is required.');
}

const databaseUrl = new URL(databaseUrlValue);
if (databaseUrl.protocol !== 'postgres:' && databaseUrl.protocol !== 'postgresql:') {
  throw new Error('DATABASE_URL must use the PostgreSQL protocol.');
}

const databaseSslCaPath = process.env.DATABASE_SSL_CA_PATH;
if (!databaseSslCaPath) {
  throw new Error('DATABASE_SSL_CA_PATH is required.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    host: databaseUrl.hostname,
    port: databaseUrl.port ? Number(databaseUrl.port) : undefined,
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
    database: decodeURIComponent(databaseUrl.pathname.slice(1)),
    ssl: {
      ca: readFileSync(databaseSslCaPath, 'utf8'),
      rejectUnauthorized: true,
    },
  },
});
