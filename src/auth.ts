import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db/index.js';
import { sessions, users } from './db/schema.js';

export const SESSION_COOKIE = 'aavil_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SHORT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'employee';
  avatar: string;
  designation: string;
  department: string;
}

function toPublicUser(user: typeof users.$inferSelect): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatar: user.avatar ?? '/favicon.svg',
    designation: user.designation,
    department: user.department,
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieOptions(rememberMe: boolean, production: boolean) {
  return {
    httpOnly: true,
    secure: production,
    sameSite: 'lax' as const,
    path: '/',
    ...(rememberMe ? { maxAge: Math.floor(SESSION_TTL_MS / 1000) } : {}),
  };
}

export async function createSession(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  rememberMe: boolean,
  production: boolean,
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const ttl = rememberMe ? SESSION_TTL_MS : SHORT_SESSION_TTL_MS;
  const expiresAt = new Date(Date.now() + ttl);

  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
  });

  reply.setCookie(SESSION_COOKIE, token, cookieOptions(rememberMe, production));
  request.log.info({ userId }, 'User session created');
}

export async function authenticate(
  request: FastifyRequest,
): Promise<PublicUser | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;

  const [result] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(
      eq(sessions.tokenHash, hashToken(token)),
      gt(sessions.expiresAt, new Date()),
      eq(users.isActive, true),
    ))
    .limit(1);

  return result ? toPublicUser(result.user) : null;
}

export async function revokeSession(
  request: FastifyRequest,
  reply: FastifyReply,
  production: boolean,
): Promise<void> {
  const token = request.cookies[SESSION_COOKIE];
  if (token) {
    await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  }

  reply.clearCookie(SESSION_COOKIE, cookieOptions(false, production));
}

export async function verifyCredentials(
  email: string,
  password: string,
): Promise<PublicUser | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);

  if (!user || !user.isActive) return null;
  if (!(await bcrypt.compare(password, user.passwordHash))) return null;

  return toPublicUser(user);
}
