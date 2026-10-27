import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { db } from '../db/index.js';
import { employees, leaveRequests, notifications, users } from '../db/schema.js';

const leaveType = z.enum([
  'Annual Leave',
  'Sick Leave',
  'Casual Leave',
  'Maternity/Paternity',
  'Unpaid Leave',
]);

const applicationSchema = z.object({
  leaveType,
  startDate: z.string().date(),
  endDate: z.string().date(),
  reason: z.string().trim().min(1).max(2000),
}).refine(data => data.endDate >= data.startDate, {
  message: 'End date must be on or after the start date.',
  path: ['endDate'],
});

const reviewSchema = z.object({
  status: z.enum(['Approved', 'Rejected']),
  note: z.string().trim().max(2000).optional().default(''),
});

type EmployeeRecord = typeof employees.$inferSelect;
type LeaveRecord = typeof leaveRequests.$inferSelect;
type LeaveBalance = {
  annual: number;
  annualTotal: number;
  sick: number;
  sickTotal: number;
  casual: number;
  casualTotal: number;
};

const reviewer = alias(users, 'leave_reviewer');

function businessDays(startDate: string, endDate: string): number {
  const current = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  let count = 0;

  while (current <= end) {
    const day = current.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return count;
}

function getBalance(employee: EmployeeRecord): LeaveBalance {
  return {
    annual: employee.annualLeave,
    annualTotal: employee.annualLeaveTotal,
    sick: employee.sickLeave,
    sickTotal: employee.sickLeaveTotal,
    casual: employee.casualLeave,
    casualTotal: employee.casualLeaveTotal,
  };
}

type BalanceField = 'annualLeave' | 'sickLeave' | 'casualLeave';

function balanceField(type: z.infer<typeof leaveType>): BalanceField | null {
  switch (type) {
    case 'Annual Leave':
      return 'annualLeave';
    case 'Sick Leave':
      return 'sickLeave';
    case 'Casual Leave':
      return 'casualLeave';
    case 'Maternity/Paternity':
    case 'Unpaid Leave':
      return null;
  }
}

function availableBalance(employee: EmployeeRecord, field: BalanceField): number {
  switch (field) {
    case 'annualLeave': return employee.annualLeave;
    case 'sickLeave': return employee.sickLeave;
    case 'casualLeave': return employee.casualLeave;
  }
}

function toLeaveRequest(
  record: LeaveRecord,
  employee: EmployeeRecord,
  reviewerName: string | null,
) {
  return {
    id: record.id,
    employeeId: employee.id,
    employeeName: `${employee.firstName} ${employee.lastName}`,
    employeeAvatar: employee.avatar,
    department: employee.department,
    leaveType: record.leaveType,
    startDate: record.startDate,
    endDate: record.endDate,
    days: record.days,
    reason: record.reason,
    status: record.status,
    appliedOn: record.appliedOn,
    ...(reviewerName ? { reviewedBy: reviewerName } : {}),
    ...(record.reviewNote ? { reviewNote: record.reviewNote } : {}),
  };
}

async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<PublicUser | null> {
  const user = await authenticate(request);
  if (!user) {
    await reply.code(401).send({ error: 'Authentication required.' });
    return null;
  }
  return user;
}

async function ownEmployee(userId: string): Promise<EmployeeRecord | null> {
  const [employee] = await db.select().from(employees).where(eq(employees.userId, userId)).limit(1);
  return employee ?? null;
}

export async function registerLeaveRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;

    const ownProfile = await ownEmployee(user.id);
    if (!ownProfile) {
      return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });
    }

    const query = db.select({
      leave: leaveRequests,
      employee: employees,
      reviewerName: reviewer.name,
    })
      .from(leaveRequests)
      .innerJoin(employees, eq(leaveRequests.employeeId, employees.id))
      .leftJoin(reviewer, eq(leaveRequests.reviewedByUserId, reviewer.id));
    const rows = user.role === 'admin'
      ? await query.orderBy(asc(leaveRequests.startDate), asc(leaveRequests.createdAt))
      : await query.where(eq(leaveRequests.employeeId, ownProfile.id))
        .orderBy(asc(leaveRequests.startDate), asc(leaveRequests.createdAt));

    return {
      leaves: rows.map(row => toLeaveRequest(row.leave, row.employee, row.reviewerName)),
      leaveBalance: getBalance(ownProfile),
    };
  });

  app.post('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;

    const parsed = applicationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Check the leave type, dates, and reason.' });
    }

    const days = businessDays(parsed.data.startDate, parsed.data.endDate);
    const rangeLength = (Date.parse(`${parsed.data.endDate}T00:00:00.000Z`)
      - Date.parse(`${parsed.data.startDate}T00:00:00.000Z`)) / 86_400_000;
    if (rangeLength > 366 || days < 1 || days > 260) {
      return reply.code(400).send({ error: 'The date range must include at least one weekday and be no longer than one year.' });
    }

    const result = await db.transaction(async tx => {
      const [employee] = await tx.select().from(employees)
        .where(eq(employees.userId, user.id))
        .for('update')
        .limit(1);
      if (!employee) return { error: 'Your account does not have a linked employee profile.' as const };

      const overlapping = await tx.select({ id: leaveRequests.id }).from(leaveRequests)
        .where(and(
          eq(leaveRequests.employeeId, employee.id),
          inArray(leaveRequests.status, ['Pending', 'Approved']),
          lte(leaveRequests.startDate, parsed.data.endDate),
          gte(leaveRequests.endDate, parsed.data.startDate),
        ))
        .limit(1);
      if (overlapping.length > 0) return { error: 'This request overlaps a pending or approved leave request.' as const };

      const quota = balanceField(parsed.data.leaveType);
      if (quota && days > availableBalance(employee, quota)) {
        return { error: `Not enough ${parsed.data.leaveType.toLowerCase()} balance for this request.` as const };
      }

      const [record] = await tx.insert(leaveRequests).values({
        employeeId: employee.id,
        leaveType: parsed.data.leaveType,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        days,
        reason: parsed.data.reason,
      }).returning();

      const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));
      if (admins.length > 0) {
        await tx.insert(notifications).values(admins.map(admin => ({
          userId: admin.id,
          title: `${employee.firstName} ${employee.lastName} submitted a ${parsed.data.leaveType.toLowerCase()} request.`,
        })));
      }

      return { record, employee };
    });

    if ('error' in result && result.error) {
      const statusCode = result.error.includes('linked employee') ? 403 : 409;
      return reply.code(statusCode).send({ error: result.error });
    }

    return reply.code(201).send({
      leave: toLeaveRequest(result.record, result.employee, null),
      leaveBalance: getBalance(result.employee),
    });
  });

  app.patch('/:id/review', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: 'Administrator access required.' });
    }

    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = reviewSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'Invalid leave request ID.' });
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a valid review decision and note.' });

    const result = await db.transaction(async tx => {
      const [record] = await tx.select().from(leaveRequests)
        .where(eq(leaveRequests.id, params.data.id))
        .for('update')
        .limit(1);
      if (!record) return { error: 'Leave request not found.' as const };
      if (record.status !== 'Pending') return { error: 'This leave request has already been reviewed.' as const };

      const [employee] = await tx.select().from(employees)
        .where(eq(employees.id, record.employeeId))
        .for('update')
        .limit(1);
      if (!employee) return { error: 'Employee profile for this leave request was not found.' as const };

      const quota = parsed.data.status === 'Approved' ? balanceField(record.leaveType) : null;
      if (quota) {
        const available = availableBalance(employee, quota);
        if (record.days > available) {
          return { error: `Cannot approve: only ${available} ${record.leaveType.toLowerCase()} day(s) remain.` as const };
        }
        if (quota === 'annualLeave') {
          await tx.update(employees).set({
            annualLeave: sql`${employees.annualLeave} - ${record.days}`,
            updatedAt: new Date(),
          }).where(eq(employees.id, employee.id));
        } else if (quota === 'sickLeave') {
          await tx.update(employees).set({
            sickLeave: sql`${employees.sickLeave} - ${record.days}`,
            updatedAt: new Date(),
          }).where(eq(employees.id, employee.id));
        } else {
          await tx.update(employees).set({
            casualLeave: sql`${employees.casualLeave} - ${record.days}`,
            updatedAt: new Date(),
          }).where(eq(employees.id, employee.id));
        }
      }

      const [reviewed] = await tx.update(leaveRequests)
        .set({
          status: parsed.data.status,
          reviewedByUserId: user.id,
          reviewNote: parsed.data.note || null,
          updatedAt: new Date(),
        })
        .where(eq(leaveRequests.id, record.id))
        .returning();

      const [reviewerUser] = await tx.select({ name: users.name }).from(users)
        .where(eq(users.id, user.id))
        .limit(1);

      const [updatedEmployee] = await tx.select().from(employees)
        .where(eq(employees.id, employee.id))
        .limit(1);

      if (employee.userId) {
        await tx.insert(notifications).values({
          userId: employee.userId,
          title: `Your ${record.leaveType.toLowerCase()} request was ${parsed.data.status.toLowerCase()}.`,
        });
      }

      return { record: reviewed, employee: updatedEmployee, reviewerName: reviewerUser?.name ?? user.name };
    });

    if ('error' in result && result.error) {
      const statusCode = result.error.includes('not found') ? 404 : 409;
      return reply.code(statusCode).send({ error: result.error });
    }

    return {
      leave: toLeaveRequest(result.record, result.employee, result.reviewerName),
      leaveBalance: getBalance(result.employee),
    };
  });
}
