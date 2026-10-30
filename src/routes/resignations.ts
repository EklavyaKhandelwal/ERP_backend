import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth.js';
import { db } from '../db/index.js';
import { employees, notifications, resignations, users } from '../db/schema.js';

const NOTICE_DAYS = 30;
const ESCALATION_DAYS = 7;
const escalationIntervalMs = 60 * 60 * 1000;

const applicationSchema = z.object({
  proposedLastDay: z.string().date(),
  reason: z.enum(['Career growth', 'Higher studies', 'Personal reasons', 'Relocation', 'Health reasons', 'Other']),
  remarks: z.string().trim().min(2).max(2000),
});

const reviewSchema = z.object({
  status: z.enum(['Approved', 'Rejected']),
  note: z.string().trim().max(2000).optional().default(''),
}).refine(value => value.status !== 'Rejected' || value.note.length > 0, {
  message: 'A reason is required when rejecting an application.',
  path: ['note'],
});

async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await authenticate(request);
  if (!user) {
    await reply.code(401).send({ error: 'Authentication required.' });
    return null;
  }
  return user;
}

function toApplication(row: {
  resignation: typeof resignations.$inferSelect;
  employee: typeof employees.$inferSelect;
  reviewerName: string | null;
  reviewerEmail: string | null;
}) {
  return {
    id: row.resignation.id,
    employeeId: row.employee.id,
    employeeName: `${row.employee.firstName} ${row.employee.lastName}`,
    employeeEmail: row.employee.email,
    employeeAvatar: row.employee.avatar,
    employeeCode: `EMP-${String(row.employee.employeeNumber).padStart(4, '0')}`,
    department: row.employee.department,
    designation: row.employee.designation,
    manager: row.employee.manager,
    resignationDate: row.resignation.resignationDate,
    noticeDays: row.resignation.noticeDays,
    proposedLastDay: row.resignation.proposedLastDay,
    reason: row.resignation.reason,
    remarks: row.resignation.remarks,
    status: row.resignation.status,
    reviewedBy: row.reviewerName,
    reviewerEmail: row.reviewerEmail,
    reviewedAt: row.resignation.reviewedAt,
    reviewNote: row.resignation.reviewNote,
    approvedLastDay: row.resignation.approvedLastDay,
    escalationNotifiedAt: row.resignation.escalationNotifiedAt,
    createdAt: row.resignation.createdAt,
  };
}

async function escalateOverdueApplications(logError: (error: unknown) => void): Promise<void> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - ESCALATION_DAYS * 24 * 60 * 60 * 1000);

  await db.transaction(async tx => {
    const admins = await tx.select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.isActive, true)));
    if (!admins.length) return;

    const overdue = await tx.select({
      id: resignations.id,
      employeeId: resignations.employeeId,
      firstName: employees.firstName,
      lastName: employees.lastName,
    }).from(resignations)
      .innerJoin(employees, eq(resignations.employeeId, employees.id))
      .where(and(
        eq(resignations.status, 'Pending'),
        isNull(resignations.escalationNotifiedAt),
        lte(resignations.createdAt, cutoff),
      ))
      .limit(100);

    for (const application of overdue) {
      const [claimed] = await tx.update(resignations)
        .set({ escalationNotifiedAt: now, updatedAt: now })
        .where(and(
          eq(resignations.id, application.id),
          eq(resignations.status, 'Pending'),
          isNull(resignations.escalationNotifiedAt),
          lte(resignations.createdAt, cutoff),
        ))
        .returning({ id: resignations.id });
      if (!claimed) continue;

      const employeeName = `${application.firstName} ${application.lastName}`;
      await tx.insert(notifications).values(admins.map(admin => ({
        userId: admin.id,
        title: `Overdue resignation review: ${employeeName}'s request has been waiting 7 days.`,
      })));
    }
  }).catch(error => {
    logError(error);
  });
}

export async function registerResignationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;

    if (user.role === 'admin') {
      await escalateOverdueApplications(error => request.log.error({ err: error }, 'Resignation escalation sweep failed'));
    }

    const query = db.select({
      resignation: resignations,
      employee: employees,
      reviewerName: users.name,
      reviewerEmail: users.email,
    }).from(resignations)
      .innerJoin(employees, eq(resignations.employeeId, employees.id))
      .leftJoin(users, eq(resignations.reviewedByUserId, users.id));
    const rows = user.role === 'admin'
      ? await query.orderBy(asc(resignations.status), asc(resignations.createdAt))
      : await query.where(eq(employees.userId, user.id))
        .orderBy(asc(resignations.createdAt));

    return { resignations: rows.map(toApplication) };
  });

  app.post('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'employee') return reply.code(403).send({ error: 'Employee access required.' });

    const parsed = applicationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Provide a proposed last working day, a reason, and remarks.' });
    }
    const now = new Date();
    const resignationDate = now.toISOString().slice(0, 10);
    const earliestLastDay = new Date(now);
    earliestLastDay.setUTCDate(earliestLastDay.getUTCDate() + NOTICE_DAYS);
    const earliestLastDayString = earliestLastDay.toISOString().slice(0, 10);
    if (parsed.data.proposedLastDay < earliestLastDayString) {
      return reply.code(400).send({ error: `Your proposed last working day must allow at least ${NOTICE_DAYS} calendar days' notice.` });
    }

    try {
      const result = await db.transaction(async tx => {
        const [employee] = await tx.select().from(employees)
          .where(eq(employees.userId, user.id)).limit(1);
        if (!employee || employee.status === 'Inactive') return { kind: 'employee-missing' as const };

        const [record] = await tx.insert(resignations).values({
          employeeId: employee.id,
          resignationDate,
          noticeDays: NOTICE_DAYS,
          proposedLastDay: parsed.data.proposedLastDay,
          reason: parsed.data.reason,
          remarks: parsed.data.remarks,
        }).returning();

        const admins = await tx.select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, 'admin'), eq(users.isActive, true)));
        if (admins.length) {
          await tx.insert(notifications).values(admins.map(admin => ({
            userId: admin.id,
            title: `Resignation application submitted by ${employee.firstName} ${employee.lastName}.`,
          })));
        }
        return { kind: 'created' as const, record, employee };
      });

      if (result.kind === 'employee-missing') {
        return reply.code(404).send({ error: 'Your active employee profile could not be found.' });
      }

      return reply.code(201).send({
        resignation: toApplication({
          resignation: result.record,
          employee: result.employee,
          reviewerName: null,
          reviewerEmail: null,
        }),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'You already have a resignation application awaiting review.' });
      }
      throw error;
    }
  });

  app.patch('/:id/review', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });

    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = reviewSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'Invalid resignation application ID.' });
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a valid decision and a reason when rejecting.' });

    const now = new Date();
    const outcome = await db.transaction(async tx => {
      const [existing] = await tx.select({
        resignation: resignations,
        employee: employees,
      }).from(resignations)
        .innerJoin(employees, eq(resignations.employeeId, employees.id))
        .where(eq(resignations.id, params.data.id))
        .limit(1);
      if (!existing) return { kind: 'missing' as const };
      if (existing.resignation.status !== 'Pending') return { kind: 'reviewed' as const };

      const [updated] = await tx.update(resignations).set({
        status: parsed.data.status,
        reviewedByUserId: user.id,
        reviewedAt: now,
        reviewNote: parsed.data.note,
        approvedLastDay: parsed.data.status === 'Approved' ? existing.resignation.proposedLastDay : null,
        updatedAt: now,
      }).where(and(
        eq(resignations.id, params.data.id),
        eq(resignations.status, 'Pending'),
      )).returning();
      if (!updated) return { kind: 'reviewed' as const };

      if (existing.employee.userId) {
        await tx.insert(notifications).values({
          userId: existing.employee.userId,
          title: `Your resignation application was ${parsed.data.status.toLowerCase()}.`,
        });
      }
      return {
        kind: 'updated' as const,
        resignation: updated,
        employee: existing.employee,
      };
    });

    if (outcome.kind === 'missing') return reply.code(404).send({ error: 'Resignation application not found.' });
    if (outcome.kind === 'reviewed') return reply.code(409).send({ error: 'This resignation application has already been reviewed.' });

    return {
      resignation: toApplication({
        resignation: outcome.resignation,
        employee: outcome.employee,
        reviewerName: user.name,
        reviewerEmail: user.email,
      }),
    };
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23505';
}

export function registerResignationEscalation(app: FastifyInstance): void {
  let interval: ReturnType<typeof setInterval> | undefined;

  app.addHook('onReady', async () => {
    void escalateOverdueApplications(error => app.log.error({ err: error }, 'Resignation escalation sweep failed'));
    interval = setInterval(() => {
      void escalateOverdueApplications(error => app.log.error({ err: error }, 'Resignation escalation sweep failed'));
    }, escalationIntervalMs);
  });

  app.addHook('onClose', async () => {
    if (interval) clearInterval(interval);
  });
}
