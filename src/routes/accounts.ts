import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { db } from '../db/index.js';
import { accountAccessTokens, employees, notifications, passwordResetTokens, sessions, users } from '../db/schema.js';

const passwordSchema = z.string().min(12).max(128).refine(
  password => Buffer.byteLength(password, 'utf8') <= 72,
  'Password must not exceed 72 UTF-8 bytes.',
);
const completeSetupSchema = z.object({
  token: z.string().min(32).max(128),
  password: passwordSchema,
});

async function getUser(request: FastifyRequest, reply: FastifyReply): Promise<PublicUser | null> {
  const user = await authenticate(request);
  if (!user) {
    await reply.code(401).send({ error: 'Authentication required.' });
    return null;
  }
  return user;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23505';
}

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.post('/employees/:employeeId/access-link', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const admin = await getUser(request, reply);
    if (!admin) return reply;
    if (admin.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });

    const params = z.object({ employeeId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid employee ID.' });
    const [employee] = await db.select().from(employees)
      .where(eq(employees.id, params.data.employeeId)).limit(1);
    if (!employee) return reply.code(404).send({ error: 'Employee not found.' });
    if (employee.status === 'Inactive') {
      return reply.code(409).send({ error: 'Reactivate this employee record before issuing an access link.' });
    }

    let purpose: 'setup' | 'reset' = 'setup';
    if (employee.userId) {
      const [linkedUser] = await db.select({ id: users.id, role: users.role })
        .from(users).where(eq(users.id, employee.userId)).limit(1);
      if (!linkedUser || linkedUser.role !== 'employee') {
        return reply.code(409).send({ error: 'The linked account cannot receive employee access.' });
      }
      purpose = 'reset';
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const now = new Date();
    try {
      await db.transaction(async tx => {
        await tx.update(accountAccessTokens)
          .set({ consumedAt: now })
          .where(and(
            eq(accountAccessTokens.employeeId, employee.id),
            isNull(accountAccessTokens.consumedAt),
          ));
        await tx.insert(accountAccessTokens).values({
          employeeId: employee.id,
          createdByUserId: admin.id,
          tokenHash,
          purpose,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ error: 'Unable to issue an access link. Try again.' });
      throw error;
    }

    return reply.code(201).send({
      purpose,
      accessPath: `/account/setup?token=${encodeURIComponent(token)}`,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  app.patch('/employees/:employeeId/active', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const admin = await getUser(request, reply);
    if (!admin) return reply;
    if (admin.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const params = z.object({ employeeId: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ isActive: z.boolean() }).safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'Invalid employee ID.' });
    if (!body.success) return reply.code(400).send({ error: 'Provide a valid account access status.' });

    const result = await db.transaction(async tx => {
      const [employee] = await tx.select({
        id: employees.id,
        userId: employees.userId,
        status: employees.status,
      }).from(employees).where(eq(employees.id, params.data.employeeId)).limit(1);
      if (!employee) return { kind: 'missing' as const };
      if (!employee.userId) return { kind: 'no-account' as const };
      if (body.data.isActive && employee.status === 'Inactive') return { kind: 'inactive-employee' as const };
      const [account] = await tx.select({ id: users.id, role: users.role })
        .from(users).where(eq(users.id, employee.userId)).limit(1);
      if (!account || account.role !== 'employee') return { kind: 'no-account' as const };
      await tx.update(users).set({ isActive: body.data.isActive, updatedAt: new Date() })
        .where(eq(users.id, account.id));
      if (!body.data.isActive) await tx.delete(sessions).where(eq(sessions.userId, account.id));
      return { kind: 'updated' as const };
    });
    if (result.kind === 'missing') return reply.code(404).send({ error: 'Employee not found.' });
    if (result.kind === 'no-account') return reply.code(409).send({ error: 'This employee does not have a login account yet.' });
    if (result.kind === 'inactive-employee') return reply.code(409).send({ error: 'Reactivate the employee record before enabling account access.' });
    return { account: { isActive: body.data.isActive } };
  });

  app.post('/complete-setup', {
    config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = completeSetupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a valid access token and a password of at least 12 characters.' });

    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const tokenHash = hashToken(parsed.data.token);
    const now = new Date();
    const result = await db.transaction(async tx => {
      const [accessToken] = await tx.update(accountAccessTokens).set({ consumedAt: now })
        .where(and(
          eq(accountAccessTokens.tokenHash, tokenHash),
          isNull(accountAccessTokens.consumedAt),
          gt(accountAccessTokens.expiresAt, now),
        )).returning();
      if (!accessToken) return 'invalid' as const;

      const [employee] = await tx.select().from(employees)
        .where(eq(employees.id, accessToken.employeeId)).limit(1);
      if (!employee || employee.status === 'Inactive') return 'invalid' as const;

      if (accessToken.purpose === 'setup') {
        if (employee.userId) return 'invalid' as const;
        const [existingUser] = await tx.select({ id: users.id })
          .from(users).where(eq(users.email, employee.email.toLowerCase())).limit(1);
        if (existingUser) return 'invalid' as const;
        const [newUser] = await tx.insert(users).values({
          email: employee.email.toLowerCase(),
          passwordHash,
          name: `${employee.firstName} ${employee.lastName}`,
          role: 'employee',
          department: employee.department,
          designation: employee.designation,
          avatar: employee.avatar,
        }).returning({ id: users.id });
        await tx.update(employees).set({ userId: newUser.id, updatedAt: now })
          .where(eq(employees.id, employee.id));
        await tx.insert(notifications).values({
          userId: accessToken.createdByUserId,
          title: `${employee.firstName} ${employee.lastName} completed account setup.`,
        });
      } else {
        if (!employee.userId) return 'invalid' as const;
        const [updatedUser] = await tx.update(users).set({ passwordHash, updatedAt: now })
          .where(and(eq(users.id, employee.userId), eq(users.role, 'employee')))
          .returning({ id: users.id });
        if (!updatedUser) return 'invalid' as const;
        await tx.update(passwordResetTokens).set({ consumedAt: now })
          .where(and(
            eq(passwordResetTokens.userId, updatedUser.id),
            isNull(passwordResetTokens.consumedAt),
          ));
        await tx.update(accountAccessTokens).set({ consumedAt: now })
          .where(and(
            eq(accountAccessTokens.employeeId, employee.id),
            eq(accountAccessTokens.purpose, 'reset'),
            isNull(accountAccessTokens.consumedAt),
          ));
        await tx.delete(sessions).where(eq(sessions.userId, updatedUser.id));
        await tx.insert(notifications).values({
          userId: accessToken.createdByUserId,
          title: `${employee.firstName} ${employee.lastName} reset their password.`,
        });
      }
      return 'completed' as const;
    });

    if (result === 'invalid') {
      return reply.code(400).send({ error: 'This access link is invalid, expired, or already used. Ask an administrator for a new link.' });
    }
    return {
      message: 'Password saved. If your account is active, sign in with your work email; otherwise contact an administrator to restore access.',
    };
  });
}
