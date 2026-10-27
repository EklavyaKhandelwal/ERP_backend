# AAVIL ERP API

Fastify API backed by Supabase PostgreSQL. Requires Node.js 22.12 or newer and pnpm through Corepack.

## Render deployment

Create a Render Web Service from this repository with:

- Build command: `corepack pnpm install --frozen-lockfile --prod=false && corepack pnpm build`
- Start command: `corepack pnpm start`
- Health check path: `/api/health`

Set `DATABASE_URL` to the Supabase PostgreSQL connection string and `NODE_ENV=production`. Set `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `APP_BASE_URL` only if email recovery is enabled. Keep all values in Render environment settings; do not commit real credentials.

Apply database changes using `corepack pnpm db:migrate` after setting `DATABASE_URL`.
