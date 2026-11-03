import { and, asc, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth.js';
import { db } from '../db/index.js';
import {
  employees,
  notifications,
  resignationChecklistItems,
  resignationEvents,
  resignationPolicies,
  resignationPolicyHistory,
  resignations,
  users,
} from '../db/schema.js';

const DEFAULT_NOTICE_DAYS = 30;
const DEFAULT_REVIEW_REMINDER_DAYS = 7;
const escalationIntervalMs = 60 * 60 * 1000;
const defaultChecklist = [
  { itemKey: 'handover', title: 'Knowledge and work handover' },
  { itemKey: 'company-property', title: 'Return company property' },
  { itemKey: 'access-removal', title: 'Review and remove system access' },
  { itemKey: 'final-paperwork', title: 'Complete final paperwork and clearance' },
] as const;

const applicationSchema = z.object({
  proposedLastDay: z.string().date(),
  reason: z.enum(['Career growth', 'Higher studies', 'Personal reasons', 'Relocation', 'Health reasons', 'Other']),
  remarks: z.string().trim().min(2).max(2000),
});

const reviewSchema = z.object({
  status: z.enum(['Approved', 'Rejected']),
  approvedLastDay: z.string().date().optional(),
  note: z.string().trim().max(2000).optional().default(''),
}).refine(value => value.status !== 'Rejected' || value.note.length > 0, {
  message: 'A reason is required when rejecting an application.',
  path: ['note'],
});
const resignationPolicySchema = z.object({
  noticeDays: z.number().int().min(1).max(365),
  reviewReminderDays: z.number().int().min(1).max(30),
});

const checklistUpdateSchema = z.object({
  status: z.enum(['Pending', 'In progress', 'Completed']).optional(),
  responsibleParty: z.string().trim().max(150).optional(),
  dueDate: z.string().date().nullable().optional(),
  note: z.string().trim().max(2000).optional(),
}).strict().refine(value => Object.keys(value).length > 0, {
  message: 'Provide at least one checklist field to update.',
});
const assignmentSchema = z.object({
  assignedToUserId: z.string().uuid().nullable(),
}).strict();
const resignationAssignee = alias(users, 'resignation_assignee');

type ResignationPolicy = { noticeDays: number; reviewReminderDays: number };

function toResignationPolicy(record: typeof resignationPolicies.$inferSelect): ResignationPolicy {
  return { noticeDays: record.noticeDays, reviewReminderDays: record.reviewReminderDays };
}

async function getOrCreateResignationPolicy(): Promise<typeof resignationPolicies.$inferSelect> {
  await db.insert(resignationPolicies)
    .values({ id: 1, noticeDays: DEFAULT_NOTICE_DAYS, reviewReminderDays: DEFAULT_REVIEW_REMINDER_DAYS })
    .onConflictDoNothing();
  const [policy] = await db.select().from(resignationPolicies)
    .where(eq(resignationPolicies.id, 1))
    .limit(1);
  if (!policy) throw new Error('Unable to load company resignation policy.');
  return policy;
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000);
}

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
  assignedToName: string | null;
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
    resignationDate: row.resignation.resignationDate,
    noticeDays: row.resignation.noticeDays,
    approvedNoticeDays: row.resignation.approvedNoticeDays,
    proposedLastDay: row.resignation.proposedLastDay,
    reason: row.resignation.reason,
    remarks: row.resignation.remarks,
    status: row.resignation.status,
    assignedToUserId: row.resignation.assignedToUserId,
    assignedTo: row.assignedToName,
    reviewedBy: row.reviewerName,
    reviewerEmail: row.reviewerEmail,
    reviewedAt: row.resignation.reviewedAt,
    reviewNote: row.resignation.reviewNote,
    approvedLastDay: row.resignation.approvedLastDay,
    escalationNotifiedAt: row.resignation.escalationNotifiedAt,
    createdAt: row.resignation.createdAt,
    events: [],
    checklist: [],
  };
}

async function escalateOverdueApplications(logError: (error: unknown) => void): Promise<void> {
  const now = new Date();

  await db.transaction(async tx => {
    const [policy] = await tx.select({ reviewReminderDays: resignationPolicies.reviewReminderDays })
      .from(resignationPolicies)
      .where(eq(resignationPolicies.id, 1))
      .limit(1);
    const reminderDays = policy?.reviewReminderDays ?? DEFAULT_REVIEW_REMINDER_DAYS;
    const cutoff = new Date(now.getTime() - reminderDays * 24 * 60 * 60 * 1000);
    const admins = await tx.select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, 'admin'), eq(users.isActive, true)));
    if (!admins.length) return;

    const overdue = await tx.select({
      id: resignations.id,
      employeeId: resignations.employeeId,
      assignedToUserId: resignations.assignedToUserId,
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
      const recipients = application.assignedToUserId
        ? admins.filter(admin => admin.id === application.assignedToUserId)
        : admins;
      const escalationRecipients = recipients.length ? recipients : admins;
      await tx.insert(notifications).values(escalationRecipients.map(admin => ({
        userId: admin.id,
        title: `Overdue resignation review: ${employeeName}'s request has been waiting ${reminderDays} days.`,
      })));
    }
  }).catch(error => {
    logError(error);
  });
}

export async function registerResignationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/policy', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    return { policy: toResignationPolicy(await getOrCreateResignationPolicy()) };
  });

  app.get('/policy/history', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: 'Administrator access required.' });
    }

    const changer = db.select({
      noticeDays: resignationPolicyHistory.noticeDays,
      reviewReminderDays: resignationPolicyHistory.reviewReminderDays,
      changedBy: users.name,
      changedAt: resignationPolicyHistory.changedAt,
    }).from(resignationPolicyHistory)
      .leftJoin(users, eq(resignationPolicyHistory.changedByUserId, users.id))
      .orderBy(desc(resignationPolicyHistory.changedAt))
      .limit(20);
    return {
      history: (await changer).map(change => ({
        noticeDays: change.noticeDays,
        reviewReminderDays: change.reviewReminderDays,
        changedBy: change.changedBy,
        changedAt: change.changedAt.toISOString(),
      })),
    };
  });

  app.get('/reviewers', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const reviewers = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
    }).from(users)
      .where(and(eq(users.role, 'admin'), eq(users.isActive, true)))
      .orderBy(asc(users.name));
    return { reviewers };
  });

  app.put('/policy', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: 'Administrator access required.' });
    }

    const parsed = resignationPolicySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Notice period must be a whole number between 1 and 365 days.' });
    }

    await getOrCreateResignationPolicy();
    const policy = await db.transaction(async tx => {
      const [previous] = await tx.select().from(resignationPolicies)
        .where(eq(resignationPolicies.id, 1))
        .for('update')
        .limit(1);
      if (!previous) throw new Error('Company resignation policy was not initialized.');

      const [updated] = await tx.update(resignationPolicies)
        .set({
          noticeDays: parsed.data.noticeDays,
          reviewReminderDays: parsed.data.reviewReminderDays,
          updatedByUserId: user.id,
          updatedAt: new Date(),
        })
        .where(eq(resignationPolicies.id, 1))
        .returning();

      if (
        previous.noticeDays !== parsed.data.noticeDays
        || previous.reviewReminderDays !== parsed.data.reviewReminderDays
      ) {
        await tx.insert(resignationPolicyHistory).values({
          noticeDays: parsed.data.noticeDays,
          reviewReminderDays: parsed.data.reviewReminderDays,
          changedByUserId: user.id,
        });
      }
      return updated;
    });
    return { policy: toResignationPolicy(policy) };
  });

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
      assignedToName: resignationAssignee.name,
    }).from(resignations)
      .innerJoin(employees, eq(resignations.employeeId, employees.id))
      .leftJoin(users, eq(resignations.reviewedByUserId, users.id))
      .leftJoin(resignationAssignee, eq(resignations.assignedToUserId, resignationAssignee.id));
    const rows = user.role === 'admin'
      ? await query.orderBy(asc(resignations.status), asc(resignations.createdAt))
      : await query.where(eq(employees.userId, user.id))
        .orderBy(asc(resignations.createdAt));

    const ids = rows.map(row => row.resignation.id);
    const events = ids.length
      ? await db.select({
        event: resignationEvents,
        actorName: users.name,
      }).from(resignationEvents)
        .leftJoin(users, eq(resignationEvents.actorUserId, users.id))
        .where(inArray(resignationEvents.resignationId, ids))
        .orderBy(asc(resignationEvents.createdAt))
      : [];
    const checklist = ids.length
      ? await db.select().from(resignationChecklistItems)
        .where(inArray(resignationChecklistItems.resignationId, ids))
        .orderBy(asc(resignationChecklistItems.createdAt))
      : [];
    const eventsByApplication = new Map<string, {
      id: string;
      eventType: string;
      description: string;
      actorName: string | null;
      createdAt: string;
    }[]>();
    for (const { event, actorName } of events) {
      const current = eventsByApplication.get(event.resignationId) ?? [];
      current.push({
        id: event.id,
        eventType: event.eventType,
        description: event.description,
        actorName,
        createdAt: event.createdAt.toISOString(),
      });
      eventsByApplication.set(event.resignationId, current);
    }
    const checklistByApplication = new Map<string, {
      id: string;
      itemKey: string;
      title: string;
      status: typeof resignationChecklistItems.$inferSelect.status;
      responsibleParty: string;
      dueDate: string | null;
      note: string;
      updatedAt: string;
    }[]>();
    for (const item of checklist) {
      const current = checklistByApplication.get(item.resignationId) ?? [];
      current.push({
        id: item.id,
        itemKey: item.itemKey,
        title: item.title,
        status: item.status,
        responsibleParty: item.responsibleParty,
        dueDate: item.dueDate,
        note: item.note,
        updatedAt: item.updatedAt.toISOString(),
      });
      checklistByApplication.set(item.resignationId, current);
    }
    const serialized = rows.map(row => ({
        ...toApplication(row),
        events: eventsByApplication.get(row.resignation.id) ?? [],
        checklist: checklistByApplication.get(row.resignation.id) ?? [],
      }));
    return {
      resignations: user.role === 'admin'
        ? serialized
        : serialized.map(application => ({ ...application, assignedToUserId: null })),
    };
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

    try {
      await getOrCreateResignationPolicy();
      const result = await db.transaction(async tx => {
        const [employee] = await tx.select().from(employees)
          .where(eq(employees.userId, user.id)).limit(1);
        if (!employee || employee.status === 'Inactive') return { kind: 'employee-missing' as const };

        const [policy] = await tx.select().from(resignationPolicies)
          .where(eq(resignationPolicies.id, 1))
          .for('share')
          .limit(1);
        const noticeDays = policy?.noticeDays ?? DEFAULT_NOTICE_DAYS;
        const now = new Date();
        const resignationDate = now.toISOString().slice(0, 10);
        const earliestLastDay = new Date(`${resignationDate}T00:00:00.000Z`);
        earliestLastDay.setUTCDate(earliestLastDay.getUTCDate() + noticeDays);
        const earliestLastDayString = earliestLastDay.toISOString().slice(0, 10);
        if (parsed.data.proposedLastDay < earliestLastDayString) {
          return { kind: 'notice-too-short' as const, noticeDays };
        }

        const [record] = await tx.insert(resignations).values({
          employeeId: employee.id,
          resignationDate,
          noticeDays,
          proposedLastDay: parsed.data.proposedLastDay,
          reason: parsed.data.reason,
          remarks: parsed.data.remarks,
        }).returning();
        const [event] = await tx.insert(resignationEvents).values({
          resignationId: record.id,
          eventType: 'Submitted',
          description: `Resignation request submitted with a proposed last working day of ${parsed.data.proposedLastDay}.`,
          actorUserId: user.id,
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
        return { kind: 'created' as const, record, employee, event };
      });

      if (result.kind === 'employee-missing') {
        return reply.code(404).send({ error: 'Your active employee profile could not be found.' });
      }
      if (result.kind === 'notice-too-short') {
        return reply.code(400).send({ error: `Your proposed last working day must allow at least ${result.noticeDays} calendar days' notice.` });
      }

      const resignation = toApplication({
        resignation: result.record,
        employee: result.employee,
        reviewerName: null,
        reviewerEmail: null,
        assignedToName: null,
      });
      return reply.code(201).send({
        resignation: {
          ...resignation,
          events: [{
            id: result.event.id,
            eventType: result.event.eventType,
            description: result.event.description,
            actorName: user.name,
            createdAt: result.event.createdAt.toISOString(),
          }],
        },
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

      const approvedLastDay = parsed.data.approvedLastDay ?? existing.resignation.proposedLastDay;
      if (parsed.data.status === 'Approved' && approvedLastDay < existing.resignation.resignationDate) {
        return { kind: 'invalid-date' as const };
      }
      if (
        parsed.data.status === 'Approved'
        && approvedLastDay !== existing.resignation.proposedLastDay
        && parsed.data.note.length === 0
      ) {
        return { kind: 'date-change-note-required' as const };
      }

      const [updated] = await tx.update(resignations).set({
        status: parsed.data.status,
        reviewedByUserId: user.id,
        reviewedAt: now,
        reviewNote: parsed.data.note,
        approvedLastDay: parsed.data.status === 'Approved' ? approvedLastDay : null,
        approvedNoticeDays: parsed.data.status === 'Approved'
          ? daysBetween(existing.resignation.resignationDate, approvedLastDay)
          : null,
        updatedAt: now,
      }).where(and(
        eq(resignations.id, params.data.id),
        eq(resignations.status, 'Pending'),
      )).returning();
      if (!updated) return { kind: 'reviewed' as const };

      const description = parsed.data.status === 'Approved'
        ? `Approved with confirmed last working day ${approvedLastDay}.${approvedLastDay !== existing.resignation.proposedLastDay
          ? ` Employee proposed ${existing.resignation.proposedLastDay}.`
          : ''}${parsed.data.note ? ` HR note: ${parsed.data.note}` : ''}`
        : `Rejected.${parsed.data.note ? ` HR note: ${parsed.data.note}` : ''}`;
      await tx.insert(resignationEvents).values({
        resignationId: updated.id,
        eventType: parsed.data.status,
        description,
        actorUserId: user.id,
        createdAt: now,
      });

      if (parsed.data.status === 'Approved') {
        await tx.insert(resignationChecklistItems).values(defaultChecklist.map(item => ({
          resignationId: updated.id,
          itemKey: item.itemKey,
          title: item.title,
        }))).onConflictDoNothing();
      }

      if (existing.employee.userId) {
        await tx.insert(notifications).values({
          userId: existing.employee.userId,
          title: parsed.data.status === 'Approved'
            ? `Your resignation application was approved. Confirmed last working day: ${approvedLastDay}.`
            : 'Your resignation application was rejected.',
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
    if (outcome.kind === 'invalid-date') {
      return reply.code(400).send({ error: 'The confirmed last working day cannot be before the resignation date.' });
    }
    if (outcome.kind === 'date-change-note-required') {
      return reply.code(400).send({ error: 'Explain any change to the employee’s proposed last working day.' });
    }

    return {
      resignation: toApplication({
        resignation: outcome.resignation,
        employee: outcome.employee,
        reviewerName: user.name,
        reviewerEmail: user.email,
        assignedToName: null,
      }),
    };
  });

  app.patch('/:id/assignment', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });

    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = assignmentSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'Invalid resignation application ID.' });
    if (!parsed.success) return reply.code(400).send({ error: 'Select an active administrator or leave the request unassigned.' });

    const result = await db.transaction(async tx => {
      const [existing] = await tx.select({
        resignation: resignations,
        employee: employees,
      }).from(resignations)
        .innerJoin(employees, eq(resignations.employeeId, employees.id))
        .where(eq(resignations.id, params.data.id))
        .limit(1);
      if (!existing) return { kind: 'missing' as const };
      if (existing.resignation.status !== 'Pending') return { kind: 'not-pending' as const };
      if (existing.resignation.assignedToUserId === parsed.data.assignedToUserId) {
        return { kind: 'unchanged' as const };
      }

      const assignee = parsed.data.assignedToUserId
        ? (await tx.select({ id: users.id, name: users.name })
          .from(users)
          .where(and(
            eq(users.id, parsed.data.assignedToUserId),
            eq(users.role, 'admin'),
            eq(users.isActive, true),
          ))
          .limit(1))[0]
        : null;
      if (parsed.data.assignedToUserId && !assignee) return { kind: 'invalid-assignee' as const };

      const previousAssignee = existing.resignation.assignedToUserId
        ? (await tx.select({ name: users.name })
          .from(users)
          .where(eq(users.id, existing.resignation.assignedToUserId))
          .limit(1))[0]?.name ?? 'Former administrator'
        : 'Unassigned';
      const nextAssignee = assignee?.name ?? 'Unassigned';
      const [updated] = await tx.update(resignations)
        .set({
          assignedToUserId: parsed.data.assignedToUserId,
          updatedAt: new Date(),
        })
        .where(and(
          eq(resignations.id, params.data.id),
          eq(resignations.status, 'Pending'),
        ))
        .returning({ id: resignations.id });
      if (!updated) return { kind: 'not-pending' as const };

      await tx.insert(resignationEvents).values({
        resignationId: updated.id,
        eventType: 'Review assigned',
        description: `Review responsibility changed from ${previousAssignee} to ${nextAssignee}.`,
        actorUserId: user.id,
      });
      if (assignee && assignee.id !== user.id) {
        await tx.insert(notifications).values({
          userId: assignee.id,
          title: `You are assigned to review ${existing.employee.firstName} ${existing.employee.lastName}'s resignation request.`,
        });
      }
      return { kind: 'updated' as const };
    });

    if (result.kind === 'missing') return reply.code(404).send({ error: 'Resignation application not found.' });
    if (result.kind === 'not-pending') return reply.code(409).send({ error: 'Only pending resignation applications can be assigned.' });
    if (result.kind === 'invalid-assignee') return reply.code(400).send({ error: 'The selected reviewer is not an active administrator.' });
    return { success: true as const };
  });

  app.patch('/:id/checklist/:itemId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });

    const params = z.object({ id: z.string().uuid(), itemId: z.string().uuid() }).safeParse(request.params);
    const parsed = checklistUpdateSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'Invalid resignation checklist ID.' });
    if (!parsed.success) return reply.code(400).send({ error: 'Provide valid checklist fields to update.' });

    const result = await db.transaction(async tx => {
      const [existing] = await tx.select().from(resignationChecklistItems)
        .where(and(
          eq(resignationChecklistItems.id, params.data.itemId),
          eq(resignationChecklistItems.resignationId, params.data.id),
        ))
        .limit(1);
      if (!existing) return { kind: 'missing' as const };

      const [item] = await tx.update(resignationChecklistItems)
        .set({
          ...parsed.data,
          updatedByUserId: user.id,
          updatedAt: new Date(),
        })
        .where(and(
          eq(resignationChecklistItems.id, params.data.itemId),
          eq(resignationChecklistItems.resignationId, params.data.id),
        ))
        .returning();
      const changed = [
        parsed.data.status && `status: ${existing.status} to ${parsed.data.status}`,
        parsed.data.responsibleParty !== undefined && `responsible party: ${existing.responsibleParty || 'unassigned'} to ${parsed.data.responsibleParty || 'unassigned'}`,
        parsed.data.dueDate !== undefined && `due date: ${existing.dueDate ?? 'not set'} to ${parsed.data.dueDate ?? 'not set'}`,
        parsed.data.note !== undefined && 'note updated',
      ].filter(Boolean);
      await tx.insert(resignationEvents).values({
        resignationId: params.data.id,
        eventType: 'Checklist updated',
        description: `${existing.title} — ${changed.join('; ')}.`,
        actorUserId: user.id,
      });
      return { kind: 'updated' as const, item };
    });

    if (result.kind === 'missing') return reply.code(404).send({ error: 'Resignation checklist item not found.' });
    return {
      item: {
        id: result.item.id,
        itemKey: result.item.itemKey,
        title: result.item.title,
        status: result.item.status,
        responsibleParty: result.item.responsibleParty,
        dueDate: result.item.dueDate,
        note: result.item.note,
        updatedAt: result.item.updatedAt.toISOString(),
      },
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
