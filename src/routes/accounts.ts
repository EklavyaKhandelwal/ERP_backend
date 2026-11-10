import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { db } from '../db/index.js';
import { accountAccessTokens, employeeDocuments, employees, passwordResetTokens, sessions, users } from '../db/schema.js';
import { isEmployeeAccessEmailConfigured, sendEmployeeAccessEmail } from '../email.js';
import { env } from '../env.js';
import { insertUserNotifications } from '../notifications.js';

const passwordSchema = z.string().min(12).max(128).refine(
  password => Buffer.byteLength(password, 'utf8') <= 72,
  'Password must not exceed 72 UTF-8 bytes.',
);
const onboardingBodyLimit = 36 * 1024 * 1024;
const documentTypes = ['offer_letter', 'education_certificate', 'government_id', 'bond_agreement', 'nda'] as const;
const requiredDocumentTypes = ['offer_letter', 'education_certificate', 'government_id'] as const;
const optionalDocumentTypes = ['bond_agreement', 'nda'] as const;
const documentSchema = z.object({
  documentType: z.enum(documentTypes),
  fileName: z.string().trim().min(1).max(180),
  contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
  data: z.string().min(1).max(7_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
const onboardingSchema = z.object({
  fullName: z.string().trim().min(2).max(200),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
      const date = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(date.getTime())
        && date.toISOString().slice(0, 10) === value
        && value < new Date().toISOString().slice(0, 10);
  }),
  phone: z.string().trim().min(7).max(30).regex(/^[+\d()\-\s.]+$/).refine(value => value.replace(/\D/g, '').length >= 7),
  documents: z.array(documentSchema).max(documentTypes.length).default([]).refine(
    documents => new Set(documents.map(document => document.documentType)).size === documents.length,
    'Each document type can only be uploaded once.',
  ).refine(
    documents => requiredDocumentTypes.every(type => documents.some(document => document.documentType === type)),
    'Upload the offer letter, education certificates, and government ID.',
  ),
});
const completeSetupSchema = z.object({
  token: z.string().min(32).max(128),
  password: passwordSchema,
}).and(onboardingSchema);
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

function decodeDocuments(documents: z.infer<typeof documentSchema>[]) {
  const rows = documents.map(document => {
    const content = Buffer.from(document.data, 'base64');
    const expectedBase64 = content.toString('base64');
    if (expectedBase64 !== document.data || content.length === 0 || content.length > 5 * 1024 * 1024) {
      throw new Error('Each document must be a valid file no larger than 5 MB.');
    }
    const signatureMatches = document.contentType === 'application/pdf'
      ? content.subarray(0, 5).toString('ascii') === '%PDF-'
      : document.contentType === 'image/jpeg'
        ? content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff
        : content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!signatureMatches) throw new Error('A document file does not match its declared file type.');
    const fileName = document.fileName.replace(/[\\/\r\n"]/g, '_');
    return {
      documentType: document.documentType,
      fileName,
      contentType: document.contentType,
      content,
    };
  });
  if (rows.reduce((total, row) => total + row.content.length, 0) > 25 * 1024 * 1024) {
    throw new Error('The combined document size must not exceed 25 MB.');
  }
  return rows;
}

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function saveOnboarding(
  tx: DbTransaction,
  employee: typeof employees.$inferSelect,
  input: Pick<z.infer<typeof onboardingSchema>, 'fullName' | 'dateOfBirth' | 'phone'>,
  documents: ReturnType<typeof decodeDocuments>,
  now: Date,
) {
  const nameParts = input.fullName.trim().split(/\s+/);
  const firstName = nameParts.shift()!;
  const lastName = nameParts.join(' ');
  await tx.update(employees).set({
    firstName,
    lastName,
    phone: input.phone,
    dateOfBirth: input.dateOfBirth,
    onboardingComplete: true,
    updatedAt: now,
  }).where(eq(employees.id, employee.id)).returning({ id: employees.id });
  if (employee.userId) {
    await tx.update(users).set({ name: input.fullName.trim(), updatedAt: now })
      .where(eq(users.id, employee.userId));
  }
  await tx.insert(employeeDocuments).values(documents.map(document => ({
    ...document,
    employeeId: employee.id,
    uploadedAt: now,
  }))).onConflictDoUpdate({
    target: [employeeDocuments.employeeId, employeeDocuments.documentType],
    set: {
      fileName: employeeDocuments.fileName,
      contentType: employeeDocuments.contentType,
      content: employeeDocuments.content,
      uploadedAt: now,
    },
  });
}

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.post('/employees/:employeeId/access-link', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const admin = await getUser(request, reply);
    if (!admin) return reply;
    if (admin.role !== 'admin') return reply.code(403).send({ error: 'HR access required.' });

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

    const accessPath = `/account/setup?token=${encodeURIComponent(token)}`;
    const baseUrl = env.APP_BASE_URL?.replace(/\/+$/, '');
    let emailSent = false;
    if (isEmployeeAccessEmailConfigured() && baseUrl) {
      try {
        await sendEmployeeAccessEmail(employee.email, `${baseUrl}${accessPath}`, purpose);
        emailSent = true;
      } catch (error) {
        request.log.error({ err: error, employeeId: employee.id }, 'Employee access email delivery failed');
      }
    }

    return reply.code(201).send({
      purpose,
      accessPath,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      email: employee.email,
      emailSent,
    });
  });

  app.patch('/employees/:employeeId/active', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const admin = await getUser(request, reply);
    if (!admin) return reply;
    if (admin.role !== 'admin') return reply.code(403).send({ error: 'HR access required.' });
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

  app.post('/onboarding', { bodyLimit: onboardingBodyLimit }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'employee') return reply.code(403).send({ error: 'Employee access required.' });
    const parsed = onboardingSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Provide your full name, a valid date of birth and phone number, and valid optional documents.' });
    let documents: ReturnType<typeof decodeDocuments>;
    try {
      documents = decodeDocuments(parsed.data.documents);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'The uploaded documents are invalid.' });
    }

    const result = await db.transaction(async tx => {
      const [employee] = await tx.select().from(employees)
        .where(eq(employees.userId, user.id)).limit(1);
      if (!employee || employee.status === 'Inactive') return 'missing' as const;
      if (employee.onboardingComplete) return 'complete' as const;
      await saveOnboarding(tx, employee, parsed.data, documents, new Date());
      return 'completed' as const;
    });
    if (result === 'missing') return reply.code(404).send({ error: 'Your active employee record could not be found. Contact an administrator.' });
    if (result === 'complete') return reply.code(409).send({ error: 'Your employee onboarding is already complete.' });
    return { message: 'Your employee details and documents have been saved. Sign out and sign in again to continue.' };
  });

  app.get('/my-documents', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'employee') return reply.code(403).send({ error: 'Employee access required.' });

    const [employee] = await db.select({ id: employees.id })
      .from(employees).where(eq(employees.userId, user.id)).limit(1);
    if (!employee) return reply.code(404).send({ error: 'Your employee profile could not be found.' });

    const documents = await db.select({
      id: employeeDocuments.id,
      documentType: employeeDocuments.documentType,
      fileName: employeeDocuments.fileName,
      contentType: employeeDocuments.contentType,
      uploadedAt: employeeDocuments.uploadedAt,
    }).from(employeeDocuments).where(eq(employeeDocuments.employeeId, employee.id));
    return { documents };
  });

  app.get('/my-documents/:documentId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'employee') return reply.code(403).send({ error: 'Employee access required.' });
    const params = z.object({ documentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid document ID.' });

    const [employee] = await db.select({ id: employees.id })
      .from(employees).where(eq(employees.userId, user.id)).limit(1);
    if (!employee) return reply.code(404).send({ error: 'Your employee profile could not be found.' });
    const [document] = await db.select().from(employeeDocuments).where(and(
      eq(employeeDocuments.employeeId, employee.id),
      eq(employeeDocuments.id, params.data.documentId),
    )).limit(1);
    if (!document) return reply.code(404).send({ error: 'Document not found.' });

    return reply
      .header('content-type', document.contentType)
      .header('content-disposition', `inline; filename="document"; filename*=UTF-8''${encodeURIComponent(document.fileName)}`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'")
      .header('referrer-policy', 'no-referrer')
      .send(document.content);
  });

  app.put('/my-documents/:documentType', { bodyLimit: 7_100_000 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'employee') return reply.code(403).send({ error: 'Employee access required.' });

    const params = z.object({
      documentType: z.enum(documentTypes),
    }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid document type.' });
    const parsed = documentSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.documentType !== params.data.documentType) {
      return reply.code(400).send({ error: 'Provide a valid replacement document of the selected type.' });
    }

    let decodedDocuments: ReturnType<typeof decodeDocuments>;
    try {
      decodedDocuments = decodeDocuments([parsed.data]);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'The uploaded document is invalid.' });
    }
    const [document] = decodedDocuments;

    const [employee] = await db.select({ id: employees.id, onboardingComplete: employees.onboardingComplete })
      .from(employees).where(eq(employees.userId, user.id)).limit(1);
    if (!employee) return reply.code(404).send({ error: 'Your employee profile could not be found.' });
    if (!employee.onboardingComplete) {
      return reply.code(403).send({ error: 'Complete onboarding before changing your documents.' });
    }

    const [updated] = await db.insert(employeeDocuments).values({
      ...document,
      employeeId: employee.id,
      uploadedAt: new Date(),
    }).onConflictDoUpdate({
      target: [employeeDocuments.employeeId, employeeDocuments.documentType],
      set: {
        fileName: document.fileName,
        contentType: document.contentType,
        content: document.content,
        uploadedAt: new Date(),
      },
    }).returning({
      id: employeeDocuments.id,
      documentType: employeeDocuments.documentType,
      fileName: employeeDocuments.fileName,
      contentType: employeeDocuments.contentType,
      uploadedAt: employeeDocuments.uploadedAt,
    });
    return { document: updated };
  });

  app.delete('/my-documents/:documentType', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'employee') return reply.code(403).send({ error: 'Employee access required.' });

    const params = z.object({ documentType: z.enum(optionalDocumentTypes) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid document type.' });
    const [employee] = await db.select({ id: employees.id, onboardingComplete: employees.onboardingComplete })
      .from(employees).where(eq(employees.userId, user.id)).limit(1);
    if (!employee) return reply.code(404).send({ error: 'Your employee profile could not be found.' });
    if (!employee.onboardingComplete) {
      return reply.code(403).send({ error: 'Complete onboarding before changing your documents.' });
    }

    const [deleted] = await db.delete(employeeDocuments).where(and(
      eq(employeeDocuments.employeeId, employee.id),
      eq(employeeDocuments.documentType, params.data.documentType),
    )).returning({ id: employeeDocuments.id });
    if (!deleted) return reply.code(404).send({ error: 'This document has not been uploaded.' });
    return reply.code(204).send();
  });

  app.get('/employees/:employeeId/documents', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const admin = await getUser(request, reply);
    if (!admin) return reply;
    if (admin.role !== 'admin') return reply.code(403).send({ error: 'HR access required.' });
    const params = z.object({ employeeId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid employee ID.' });
    const documents = await db.select({
      id: employeeDocuments.id,
      documentType: employeeDocuments.documentType,
      fileName: employeeDocuments.fileName,
      contentType: employeeDocuments.contentType,
      uploadedAt: employeeDocuments.uploadedAt,
    }).from(employeeDocuments).where(eq(employeeDocuments.employeeId, params.data.employeeId));
    return { documents };
  });

  app.get('/employees/:employeeId/documents/:documentId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const admin = await getUser(request, reply);
    if (!admin) return reply;
    if (admin.role !== 'admin') return reply.code(403).send({ error: 'HR access required.' });
    const params = z.object({ employeeId: z.string().uuid(), documentId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid document ID.' });
    const [document] = await db.select().from(employeeDocuments).where(and(
      eq(employeeDocuments.employeeId, params.data.employeeId),
      eq(employeeDocuments.id, params.data.documentId),
    )).limit(1);
    if (!document) return reply.code(404).send({ error: 'Document not found.' });
    return reply
      .header('content-type', document.contentType)
      .header('content-disposition', `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(document.fileName)}`)
      .header('x-content-type-options', 'nosniff')
      .send(document.content);
  });

  app.post('/complete-setup', {
    bodyLimit: onboardingBodyLimit,
    config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = completeSetupSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a valid access token, password, employee details, and valid optional documents.' });
    let documents: ReturnType<typeof decodeDocuments>;
    try {
      documents = decodeDocuments(parsed.data.documents);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : 'The uploaded documents are invalid.' });
    }

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
          name: parsed.data.fullName.trim(),
          role: 'employee',
          department: employee.department,
          designation: employee.designation,
          avatar: employee.avatar,
        }).returning({ id: users.id });
        await tx.update(employees).set({ userId: newUser.id, updatedAt: now })
          .where(eq(employees.id, employee.id));
        await saveOnboarding(tx, { ...employee, userId: newUser.id }, parsed.data, documents, now);
        await insertUserNotifications(
          tx,
          [accessToken.createdByUserId],
          `${parsed.data.fullName.trim()} completed account setup.`,
          'employeeOnboarding',
        );
      } else {
        if (!employee.userId) return 'invalid' as const;
        const [updatedUser] = await tx.update(users).set({ passwordHash, name: parsed.data.fullName.trim(), updatedAt: now })
          .where(and(eq(users.id, employee.userId), eq(users.role, 'employee')))
          .returning({ id: users.id });
        if (!updatedUser) return 'invalid' as const;
        await saveOnboarding(tx, employee, parsed.data, documents, now);
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
        await insertUserNotifications(
          tx,
          [accessToken.createdByUserId],
          `${parsed.data.fullName.trim()} completed onboarding and reset their password.`,
          'employeeOnboarding',
        );
      }
      return 'completed' as const;
    });

    if (result === 'invalid') {
      return reply.code(400).send({ error: 'This access link is invalid, expired, or already used. Ask an administrator for a new link.' });
    }
    return {
      message: 'Your password, profile, and documents are saved. Sign in with your work email to continue.',
    };
  });
}
