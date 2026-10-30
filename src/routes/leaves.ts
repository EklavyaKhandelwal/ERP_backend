import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { db } from '../db/index.js';
import { employeeLeaveBalances, employees, leavePolicies, leavePolicyHistory, leaveRequests, users } from '../db/schema.js';
import { insertUserNotifications } from '../notifications.js';

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
  year: number;
  annual: number;
  annualTotal: number;
  annualPending: number;
  sick: number;
  sickTotal: number;
  sickPending: number;
  casual: number;
  casualTotal: number;
  casualPending: number;
};

type LeavePolicy = {
  annual: number;
  sick: number;
  casual: number;
};
type YearBalanceRecord = typeof employeeLeaveBalances.$inferSelect;

const leavePolicySchema = z.object({
  annual: z.number().int().min(0).max(366),
  sick: z.number().int().min(0).max(366),
  casual: z.number().int().min(0).max(366),
});

const reviewer = alias(users, 'leave_reviewer');
const policyChanger = alias(users, 'leave_policy_changer');

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

function businessDaysForYear(startDate: string, endDate: string, year: number): number {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const clippedStart = startDate > yearStart ? startDate : yearStart;
  const clippedEnd = endDate < yearEnd ? endDate : yearEnd;
  return clippedStart <= clippedEnd ? businessDays(clippedStart, clippedEnd) : 0;
}

function requestYears(startDate: string, endDate: string): number[] {
  const firstYear = Number(startDate.slice(0, 4));
  const lastYear = Number(endDate.slice(0, 4));
  return Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index);
}

function getBalance(record: YearBalanceRecord, requests: LeaveRecord[] = []): LeaveBalance {
  const pendingDays = (type: z.infer<typeof leaveType>) => requests
    .filter(request => request.status === 'Pending' && request.leaveType === type)
    .reduce((total, request) => total + businessDaysForYear(request.startDate, request.endDate, record.year), 0);
  return {
    year: record.year,
    annual: record.annualBalance,
    annualTotal: record.annualTotal,
    annualPending: pendingDays('Annual Leave'),
    sick: record.sickBalance,
    sickTotal: record.sickTotal,
    sickPending: pendingDays('Sick Leave'),
    casual: record.casualBalance,
    casualTotal: record.casualTotal,
    casualPending: pendingDays('Casual Leave'),
  };
}

function toLeavePolicy(record: typeof leavePolicies.$inferSelect): LeavePolicy {
  return {
    annual: record.annualDays,
    sick: record.sickDays,
    casual: record.casualDays,
  };
}

async function getOrCreateLeavePolicy(): Promise<typeof leavePolicies.$inferSelect> {
  await db.insert(leavePolicies).values({ id: 1 }).onConflictDoNothing();
  const [policy] = await db.select().from(leavePolicies).where(eq(leavePolicies.id, 1)).limit(1);
  if (!policy) throw new Error('Unable to load company leave policy.');
  return policy;
}

type BalanceField = 'annualBalance' | 'sickBalance' | 'casualBalance';

function balanceField(type: z.infer<typeof leaveType>): BalanceField | null {
  switch (type) {
    case 'Annual Leave':
      return 'annualBalance';
    case 'Sick Leave':
      return 'sickBalance';
    case 'Casual Leave':
      return 'casualBalance';
    case 'Maternity/Paternity':
    case 'Unpaid Leave':
      return null;
  }
}

function availableBalance(balance: YearBalanceRecord, field: BalanceField): number {
  switch (field) {
    case 'annualBalance': return balance.annualBalance;
    case 'sickBalance': return balance.sickBalance;
    case 'casualBalance': return balance.casualBalance;
  }
}

async function getOrCreateYearBalance(employeeId: string, year: number): Promise<YearBalanceRecord> {
  const [existing] = await db.select().from(employeeLeaveBalances)
    .where(and(
      eq(employeeLeaveBalances.employeeId, employeeId),
      eq(employeeLeaveBalances.year, year),
    ))
    .limit(1);
  if (existing) return existing;

  const policy = await getOrCreateLeavePolicy();
  await db.insert(employeeLeaveBalances).values({
    employeeId,
    year,
    annualBalance: policy.annualDays,
    annualTotal: policy.annualDays,
    sickBalance: policy.sickDays,
    sickTotal: policy.sickDays,
    casualBalance: policy.casualDays,
    casualTotal: policy.casualDays,
  }).onConflictDoNothing();
  const [created] = await db.select().from(employeeLeaveBalances)
    .where(and(
      eq(employeeLeaveBalances.employeeId, employeeId),
      eq(employeeLeaveBalances.year, year),
    ))
    .limit(1);
  if (!created) throw new Error(`Unable to initialize leave balances for ${year}.`);
  return created;
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
  app.get('/policy', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    return { policy: toLeavePolicy(await getOrCreateLeavePolicy()) };
  });

  app.get('/policy/history', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: 'Administrator access required.' });
    }

    const history = await db.select({
      annual: leavePolicyHistory.annualDays,
      sick: leavePolicyHistory.sickDays,
      casual: leavePolicyHistory.casualDays,
      changedBy: policyChanger.name,
      changedAt: leavePolicyHistory.changedAt,
    })
      .from(leavePolicyHistory)
      .leftJoin(policyChanger, eq(leavePolicyHistory.changedByUserId, policyChanger.id))
      .orderBy(desc(leavePolicyHistory.changedAt))
      .limit(10);
    return { history };
  });

  app.put('/policy', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') {
      return reply.code(403).send({ error: 'Administrator access required.' });
    }

    const parsed = leavePolicySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Leave allowances must be whole numbers between 0 and 366.' });
    }

    await getOrCreateLeavePolicy();
    const policy = await db.transaction(async tx => {
      const [previous] = await tx.select().from(leavePolicies)
        .where(eq(leavePolicies.id, 1))
        .for('update')
        .limit(1);
      if (!previous) throw new Error('Company leave policy was not initialized.');
      const next = parsed.data;
      const changed = previous.annualDays !== next.annual
        || previous.sickDays !== next.sick
        || previous.casualDays !== next.casual;

      const [updated] = await tx.update(leavePolicies)
        .set({
          annualDays: next.annual,
          sickDays: next.sick,
          casualDays: next.casual,
          updatedByUserId: user.id,
          updatedAt: new Date(),
        })
        .where(eq(leavePolicies.id, 1))
        .returning();

      await tx.update(employeeLeaveBalances).set({
        annualBalance: sql`greatest(0, ${employeeLeaveBalances.annualBalance} + (${next.annual} - ${employeeLeaveBalances.annualTotal}))`,
        annualTotal: next.annual,
        sickBalance: sql`greatest(0, ${employeeLeaveBalances.sickBalance} + (${next.sick} - ${employeeLeaveBalances.sickTotal}))`,
        sickTotal: next.sick,
        casualBalance: sql`greatest(0, ${employeeLeaveBalances.casualBalance} + (${next.casual} - ${employeeLeaveBalances.casualTotal}))`,
        casualTotal: next.casual,
        updatedAt: new Date(),
      }).where(gte(employeeLeaveBalances.year, new Date().getFullYear()));
      if (changed) {
        await tx.insert(leavePolicyHistory).values({
          annualDays: next.annual,
          sickDays: next.sick,
          casualDays: next.casual,
          changedByUserId: user.id,
        });
      }

      return updated;
    });

    return { policy: toLeavePolicy(policy) };
  });

  app.get('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;

    const query = db.select({
      leave: leaveRequests,
      employee: employees,
      reviewerName: reviewer.name,
    })
      .from(leaveRequests)
      .innerJoin(employees, eq(leaveRequests.employeeId, employees.id))
      .leftJoin(reviewer, eq(leaveRequests.reviewedByUserId, reviewer.id));
    let rows: Awaited<ReturnType<typeof query.orderBy>>;
    let leaveBalance: LeaveBalance | null = null;
    if (user.role === 'admin') {
      rows = await query.orderBy(asc(leaveRequests.startDate), asc(leaveRequests.createdAt));
    } else {
      const ownProfile = await ownEmployee(user.id);
      if (!ownProfile) {
        return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });
      }
      rows = await query.where(eq(leaveRequests.employeeId, ownProfile.id))
        .orderBy(asc(leaveRequests.startDate), asc(leaveRequests.createdAt));
      const currentYearBalance = await getOrCreateYearBalance(ownProfile.id, new Date().getFullYear());
      leaveBalance = getBalance(currentYearBalance, rows.map(row => row.leave));
    }

    return {
      leaves: rows.map(row => toLeaveRequest(row.leave, row.employee, row.reviewerName)),
      leaveBalance,
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

    const employeeProfile = await ownEmployee(user.id);
    if (!employeeProfile) {
      return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });
    }
    const currentYear = new Date().getFullYear();
    const targetYears = requestYears(parsed.data.startDate, parsed.data.endDate);
    const balanceYears = [...new Set([...targetYears, currentYear])];
    for (const year of balanceYears) {
      await getOrCreateYearBalance(employeeProfile.id, year);
    }

    const result = await db.transaction(async tx => {
      const [employee] = await tx.select().from(employees)
        .where(eq(employees.userId, user.id))
        .for('update')
        .limit(1);
      if (!employee) return { error: 'Your account does not have a linked employee profile.' as const };

      const dateOverlaps = await tx.select({
        leaveType: leaveRequests.leaveType,
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
        status: leaveRequests.status,
      }).from(leaveRequests)
        .where(and(
          eq(leaveRequests.employeeId, employee.id),
          inArray(leaveRequests.status, ['Pending', 'Approved']),
          lte(leaveRequests.startDate, parsed.data.endDate),
          gte(leaveRequests.endDate, parsed.data.startDate),
        ));
      const overlapping = dateOverlaps.find(request => {
        const overlapStart = request.startDate > parsed.data.startDate ? request.startDate : parsed.data.startDate;
        const overlapEnd = request.endDate < parsed.data.endDate ? request.endDate : parsed.data.endDate;
        return businessDays(overlapStart, overlapEnd) > 0;
      });
      if (overlapping) {
        const formatDate = (date: string) => new Date(`${date}T00:00:00.000Z`).toLocaleDateString('en-IN', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        });
        return {
          error: `This overlaps your ${overlapping.status.toLowerCase()} ${overlapping.leaveType} request (${formatDate(overlapping.startDate)}–${formatDate(overlapping.endDate)}).` as const,
        };
      }

      const yearBalances = await tx.select().from(employeeLeaveBalances)
        .where(and(
          eq(employeeLeaveBalances.employeeId, employee.id),
          inArray(employeeLeaveBalances.year, balanceYears),
        ))
        .for('update');
      const balanceByYear = new Map(yearBalances.map(balance => [balance.year, balance]));
      const quota = balanceField(parsed.data.leaveType);
      if (quota) {
        const pendingRequests = await tx.select().from(leaveRequests)
          .where(and(
            eq(leaveRequests.employeeId, employee.id),
            eq(leaveRequests.leaveType, parsed.data.leaveType),
            eq(leaveRequests.status, 'Pending'),
          ));
        for (const year of targetYears) {
          const balance = balanceByYear.get(year);
          if (!balance) throw new Error(`Leave balance for ${year} was not initialized.`);
          const pendingDays = pendingRequests.reduce(
            (total, request) => total + businessDaysForYear(request.startDate, request.endDate, year),
            0,
          );
          const available = Math.max(0, availableBalance(balance, quota) - pendingDays);
          const requestedDays = businessDaysForYear(parsed.data.startDate, parsed.data.endDate, year);
          if (requestedDays > available) {
            return { error: `Not enough ${parsed.data.leaveType.toLowerCase()} balance for ${year} after pending requests. ${available} day(s) are available.` as const };
          }
        }
      }

      const [record] = await tx.insert(leaveRequests).values({
        employeeId: employee.id,
        leaveType: parsed.data.leaveType,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        days,
        reason: parsed.data.reason,
      }).returning();
      const pendingRequests = await tx.select().from(leaveRequests)
        .where(and(
          eq(leaveRequests.employeeId, employee.id),
          eq(leaveRequests.status, 'Pending'),
        ));
      const currentYearBalance = balanceByYear.get(currentYear);
      if (!currentYearBalance) throw new Error(`Leave balance for ${currentYear} was not initialized.`);

      const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));
      if (admins.length > 0) {
        await insertUserNotifications(
          tx,
          admins.map(admin => admin.id),
          `${employee.firstName} ${employee.lastName} submitted a ${parsed.data.leaveType.toLowerCase()} request.`,
          'leaveRequests',
        );
      }

      return { record, employee, pendingRequests, currentYearBalance };
    });

    if ('error' in result && result.error) {
      const statusCode = result.error.includes('linked employee') ? 403 : 409;
      return reply.code(statusCode).send({ error: result.error });
    }

    return reply.code(201).send({
      leave: toLeaveRequest(result.record, result.employee, null),
      leaveBalance: getBalance(result.currentYearBalance, result.pendingRequests),
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

    const [requestForBalance] = await db.select().from(leaveRequests)
      .where(eq(leaveRequests.id, params.data.id))
      .limit(1);
    if (requestForBalance) {
      const currentYear = new Date().getFullYear();
      const [employeeForBalance] = await db.select({ id: employees.id }).from(employees)
        .where(eq(employees.id, requestForBalance.employeeId))
        .limit(1);
      if (employeeForBalance) {
        const years = [...new Set([...requestYears(requestForBalance.startDate, requestForBalance.endDate), currentYear])];
        for (const year of years) {
          await getOrCreateYearBalance(employeeForBalance.id, year);
        }
      }
    }

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

      const currentYear = new Date().getFullYear();
      const years = [...new Set([...requestYears(record.startDate, record.endDate), currentYear])];
      const yearBalances = await tx.select().from(employeeLeaveBalances)
        .where(and(
          eq(employeeLeaveBalances.employeeId, employee.id),
          inArray(employeeLeaveBalances.year, years),
        ))
        .for('update');
      const balanceByYear = new Map(yearBalances.map(balance => [balance.year, balance]));
      const quota = parsed.data.status === 'Approved' ? balanceField(record.leaveType) : null;
      if (quota) {
        for (const year of requestYears(record.startDate, record.endDate)) {
          const balance = balanceByYear.get(year);
          if (!balance) throw new Error(`Leave balance for ${year} was not initialized.`);
          const requestedDays = businessDaysForYear(record.startDate, record.endDate, year);
          const available = availableBalance(balance, quota);
          if (requestedDays > available) {
            return { error: `Cannot approve: only ${available} ${record.leaveType.toLowerCase()} day(s) remain for ${year}.` as const };
          }
          const update = quota === 'annualBalance'
            ? { annualBalance: sql`${employeeLeaveBalances.annualBalance} - ${requestedDays}` }
            : quota === 'sickBalance'
              ? { sickBalance: sql`${employeeLeaveBalances.sickBalance} - ${requestedDays}` }
              : { casualBalance: sql`${employeeLeaveBalances.casualBalance} - ${requestedDays}` };
          await tx.update(employeeLeaveBalances).set({
            ...update,
            updatedAt: new Date(),
          }).where(and(
            eq(employeeLeaveBalances.employeeId, employee.id),
            eq(employeeLeaveBalances.year, year),
          ));
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
      const pendingRequests = await tx.select().from(leaveRequests)
        .where(and(
          eq(leaveRequests.employeeId, employee.id),
          eq(leaveRequests.status, 'Pending'),
        ));
      const currentYearBalance = balanceByYear.get(currentYear);
      if (!currentYearBalance) throw new Error(`Leave balance for ${currentYear} was not initialized.`);

      if (employee.userId) {
        await insertUserNotifications(
          tx,
          [employee.userId],
          `Your ${record.leaveType.toLowerCase()} request was ${parsed.data.status.toLowerCase()}.`,
          'leaveRequests',
        );
      }

      return { record: reviewed, employee: updatedEmployee, reviewerName: reviewerUser?.name ?? user.name, pendingRequests, currentYearBalance };
    });

    if ('error' in result && result.error) {
      const statusCode = result.error.includes('not found') ? 404 : 409;
      return reply.code(statusCode).send({ error: result.error });
    }

    return {
      leave: toLeaveRequest(result.record, result.employee, result.reviewerName),
      leaveBalance: getBalance(result.currentYearBalance, result.pendingRequests),
    };
  });
}
