import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { authenticate, createSession, revokeSession, verifyCredentials } from '../auth.js';
import { db } from '../db/index.js';
import { accountAccessTokens, employees, passwordResetTokens, sessions, users } from '../db/schema.js';
import { isPasswordResetEmailConfigured, sendPasswordResetEmail } from '../email.js';
import { env } from '../env.js';

const requestPasswordResetSchema = z.object({
  email: z.string().email().max(254),
});

const passwordResetSchema = z.object({
  token: z.string().min(32).max(128),
  password: z.string().min(12).max(128).refine(
    password => Buffer.byteLength(password, 'utf8') <= 72,
    'Password must not exceed 72 UTF-8 bytes.',
  ),
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128).refine(
    password => Buffer.byteLength(password, 'utf8') <= 72,
    'Password is too long.',
  ),
  rememberMe: z.boolean().default(false),
});

const profileAvatarSchema = z.object({
  avatar: z.string().max(7_000_000).regex(
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
  ),
});

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isValidAvatar(avatar: string): boolean {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(avatar);
  if (!match) return false;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024) return false;

  if (match[1] === 'png') {
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (match[1] === 'jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  return bytes.length >= 12
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP';
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/login', {
    config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Enter a valid email and password.' });
    }

    const user = await verifyCredentials(parsed.data.email, parsed.data.password);
    if (!user) {
      return reply.code(401).send({ error: 'Invalid email or password.' });
    }

    await createSession(request, reply, user.id, parsed.data.rememberMe, env.NODE_ENV === 'production');
    return reply.code(200).send({ user });
  });

  app.post('/forgot-password', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const baseUrl = env.APP_BASE_URL?.replace(/\/+$/, '');
    if (!isPasswordResetEmailConfigured() || !baseUrl) {
      return reply.code(503).send({ error: 'Password recovery is not configured yet. Contact an administrator.' });
    }

    const parsed = requestPasswordResetSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter a valid email address.' });

    const email = parsed.data.email.trim().toLowerCase();
    const [user] = await db.select({
      id: users.id,
      email: users.email,
      isActive: users.isActive,
    }).from(users).where(eq(users.email, email)).limit(1);

    if (user?.isActive) {
      const token = randomBytes(32).toString('base64url');
      const tokenHash = hashToken(token);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);

      await db.transaction(async tx => {
        await tx.update(passwordResetTokens).set({ consumedAt: now })
          .where(and(
            eq(passwordResetTokens.userId, user.id),
            isNull(passwordResetTokens.consumedAt),
          ));
        await tx.insert(passwordResetTokens).values({
          userId: user.id,
          tokenHash,
          expiresAt,
        });
      });

      const resetUrl = `${baseUrl}/account/password-reset#token=${encodeURIComponent(token)}`;
      try {
        await sendPasswordResetEmail(user.email, resetUrl);
      } catch (error) {
        await db.update(passwordResetTokens).set({ consumedAt: new Date() })
          .where(eq(passwordResetTokens.tokenHash, tokenHash));
        request.log.error({ err: error }, 'Password reset email delivery failed');
      }
    }

    return reply.code(202).send({
      message: 'If an active account matches that email, a password reset link will be sent shortly.',
    });
  });

  app.post('/reset-password', {
    config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = passwordResetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Provide a valid reset link and a password of at least 12 characters.' });
    }

    const tokenHash = hashToken(parsed.data.token);
    const now = new Date();
    const [candidate] = await db.select({ userId: passwordResetTokens.userId })
      .from(passwordResetTokens)
      .where(and(
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.consumedAt),
        gt(passwordResetTokens.expiresAt, now),
      )).limit(1);
    if (!candidate) {
      return reply.code(400).send({ error: 'This password reset link is invalid, expired, or already used. Request a new one.' });
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const result = await db.transaction(async tx => {
      const [resetToken] = await tx.update(passwordResetTokens).set({ consumedAt: now })
        .where(and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.consumedAt),
          gt(passwordResetTokens.expiresAt, now),
        )).returning({ userId: passwordResetTokens.userId });
      if (!resetToken) return false;

      const [updatedUser] = await tx.update(users)
        .set({ passwordHash, updatedAt: now })
        .where(and(eq(users.id, resetToken.userId), eq(users.isActive, true)))
        .returning({ id: users.id });
      if (!updatedUser) return false;

      await tx.update(passwordResetTokens).set({ consumedAt: now })
        .where(and(
          eq(passwordResetTokens.userId, updatedUser.id),
          isNull(passwordResetTokens.consumedAt),
        ));
      const [employee] = await tx.select({ id: employees.id })
        .from(employees).where(eq(employees.userId, updatedUser.id)).limit(1);
      if (employee) {
        await tx.update(accountAccessTokens).set({ consumedAt: now })
          .where(and(
            eq(accountAccessTokens.employeeId, employee.id),
            eq(accountAccessTokens.purpose, 'reset'),
            isNull(accountAccessTokens.consumedAt),
          ));
      }
      await tx.delete(sessions).where(eq(sessions.userId, updatedUser.id));
      return true;
    });
    if (!result) {
      return reply.code(400).send({ error: 'This password reset link is invalid, expired, or already used. Request a new one.' });
    }

    return reply.send({ message: 'Password reset successfully. Sign in with your new password.' });
  });

  app.get('/me', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await authenticate(request);
    if (!user) {
      return reply.code(401).send({ error: 'Authentication required.' });
    }

    return reply.send({ user });
  });

  app.patch('/profile/avatar', { bodyLimit: 7_100_000 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await authenticate(request);
    if (!user) return reply.code(401).send({ error: 'Authentication required.' });

    const parsed = profileAvatarSchema.safeParse(request.body);
    if (!parsed.success || !isValidAvatar(parsed.data.avatar)) {
      return reply.code(400).send({ error: 'Choose a valid PNG, JPEG, or WebP image up to 5 MB.' });
    }

    const now = new Date();
    await db.transaction(async tx => {
      await tx.update(users).set({ avatar: parsed.data.avatar, updatedAt: now })
        .where(eq(users.id, user.id));
      await tx.update(employees).set({ avatar: parsed.data.avatar, updatedAt: now })
        .where(eq(employees.userId, user.id));
    });

    return reply.send({ user: { ...user, avatar: parsed.data.avatar } });
  });

  app.post('/logout', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    await revokeSession(request, reply, env.NODE_ENV === 'production');
    return reply.code(204).send();
  });
}
