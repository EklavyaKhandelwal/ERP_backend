import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { db } from '../db/index.js';
import {
  companyHolidays,
  employeeLeaveBalances,
  employees,
  leavePolicies,
  leavePolicyHistory,
  leaveRequests,
  users,
} from '../db/schema.js';
import { insertUserNotifications } from '../notifications.js';
import {
  availableBalance,
  balanceField,
  businessDays,
  businessDaysForYear,
  getBalance,
  holidayDates,
  requestYears,
  type HolidayRecord,
  type LeaveBalance,
  type LeaveRecord,
  type YearBalanceRecord,
} from './leave-calculations.js';
import { notifyHolidayChange, reconcileLeaveBalancesForHolidayChange } from './leave-reconciliation.js';

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
const holidayInputSchema = z.object({
  name: z.string().trim().min(1).max(150),
  startDate: z.string().date(),
  endDate: z.string().date(),
  description: z.string().trim().max(1000).default(''),
}).strict().refine(value => value.endDate >= value.startDate, {
  message: 'End date must be on or after the start date.',
  path: ['endDate'],
}).refine(value => (
  (Date.parse(`${value.endDate}T00:00:00.000Z`) - Date.parse(`${value.startDate}T00:00:00.000Z`)) / 86_400_000 < 366
), {
  message: 'A holiday cannot be longer than 366 calendar days.',
  path: ['endDate'],
});

type EmployeeRecord = typeof employees.$inferSelect;
type LeavePolicy = {
  annual: number;
  sick: number;
  casual: number;
};

const leavePolicySchema = z.object({
  annual: z.number().int().min(0).max(366),
  sick: z.number().int().min(0).max(366),
  casual: z.number().int().min(0).max(366),
});

const reviewer = alias(users, 'leave_reviewer');
const policyChanger = alias(users, 'leave_policy_changer');

function serializeHoliday(holiday: HolidayRecord) {
  return {
    id: holiday.id,
    name: holiday.name,
    startDate: holiday.startDate,
    endDate: holiday.endDate,
    description: holiday.description,
    updatedAt: holiday.updatedAt.toISOString(),
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
  app.get('/holidays', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const records = await db.select().from(companyHolidays)
      .orderBy(asc(companyHolidays.startDate), asc(companyHolidays.name));
    return { holidays: records.map(serializeHoliday) };
  });

  app.post('/holidays', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const parsed = holidayInputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a holiday name and valid date range.' });

    const result = await db.transaction(async tx => {
      const [overlap] = await tx.select({ id: companyHolidays.id }).from(companyHolidays)
        .where(and(
          lte(companyHolidays.startDate, parsed.data.endDate),
          gte(companyHolidays.endDate, parsed.data.startDate),
        ))
        .limit(1);
      if (overlap) return {
        kind: 'error' as const,
        error: 'This date range overlaps an existing company holiday.',
        status: 409,
      };

      const [holiday] = await tx.insert(companyHolidays).values({
        ...parsed.data,
        createdByUserId: user.id,
        updatedByUserId: user.id,
      }).returning();
      await reconcileLeaveBalancesForHolidayChange(tx, holiday.startDate, holiday.endDate);
      await notifyHolidayChange(
        tx,
        `Company holiday added: ${holiday.name} (${holiday.startDate}${holiday.endDate === holiday.startDate ? '' : ` to ${holiday.endDate}`}).`,
      );
      return { kind: 'success' as const, holiday };
    });
    if (result.kind === 'error') return reply.code(result.status).send({ error: result.error });
    return reply.code(201).send({ holiday: serializeHoliday(result.holiday) });
  });

  app.patch('/holidays/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = holidayInputSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'Invalid holiday ID.' });
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a holiday name and valid date range.' });

    const result = await db.transaction(async tx => {
      const [existing] = await tx.select().from(companyHolidays)
        .where(eq(companyHolidays.id, params.data.id))
        .for('update')
        .limit(1);
      if (!existing) {
        return { kind: 'error' as const, error: 'Company holiday not found.', status: 404 };
      }

      const [overlap] = await tx.select({ id: companyHolidays.id }).from(companyHolidays)
        .where(and(
          ne(companyHolidays.id, existing.id),
          lte(companyHolidays.startDate, parsed.data.endDate),
          gte(companyHolidays.endDate, parsed.data.startDate),
        ))
        .limit(1);
      if (overlap) {
        return {
          kind: 'error' as const,
          error: 'This date range overlaps another company holiday.',
          status: 409,
        };
      }

      const [holiday] = await tx.update(companyHolidays).set({
        ...parsed.data,
        updatedByUserId: user.id,
        updatedAt: new Date(),
      }).where(eq(companyHolidays.id, existing.id)).returning();
      await reconcileLeaveBalancesForHolidayChange(
        tx,
        existing.startDate < holiday.startDate ? existing.startDate : holiday.startDate,
        existing.endDate > holiday.endDate ? existing.endDate : holiday.endDate,
      );
      await notifyHolidayChange(
        tx,
        `Company holiday updated: ${holiday.name} (${holiday.startDate}${holiday.endDate === holiday.startDate ? '' : ` to ${holiday.endDate}`}).`,
      );
      return { kind: 'success' as const, holiday };
    });
    if (result.kind === 'error') return reply.code(result.status).send({ error: result.error });
    return { holiday: serializeHoliday(result.holiday) };
  });

  app.delete('/holidays/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid holiday ID.' });

    const result = await db.transaction(async tx => {
      const [holiday] = await tx.select().from(companyHolidays)
        .where(eq(companyHolidays.id, params.data.id))
        .for('update')
        .limit(1);
      if (!holiday) {
        return { kind: 'error' as const, error: 'Company holiday not found.', status: 404 };
      }
      await tx.delete(companyHolidays).where(eq(companyHolidays.id, holiday.id));
      await reconcileLeaveBalancesForHolidayChange(tx, holiday.startDate, holiday.endDate);
      await notifyHolidayChange(tx, `Company holiday removed: ${holiday.name}.`);
      return { kind: 'success' as const, holidayId: holiday.id };
    });
    if (result.kind === 'error') return reply.code(result.status).send({ error: result.error });
    return { holidayId: result.holidayId };
  });

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

      const holidayRecords = await db.select().from(companyHolidays)
        .orderBy(asc(companyHolidays.startDate), asc(companyHolidays.name));
      const holidays = holidayDates(holidayRecords);
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
      leaveBalance = getBalance(currentYearBalance, rows.map(row => row.leave), holidays);
    }

    return {
      leaves: rows.map(row => toLeaveRequest(row.leave, row.employee, row.reviewerName)),
      leaveBalance,
      holidays: holidayRecords.map(serializeHoliday),
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

    const holidayRecords = await db.select().from(companyHolidays);
    const holidays = holidayDates(holidayRecords);
    const days = businessDays(parsed.data.startDate, parsed.data.endDate, holidays);
    const rangeLength = (Date.parse(`${parsed.data.endDate}T00:00:00.000Z`)
      - Date.parse(`${parsed.data.startDate}T00:00:00.000Z`)) / 86_400_000;
    if (rangeLength > 366 || days < 1 || days > 260) {
      return reply.code(400).send({ error: 'The date range must include at least one working day (excluding weekends and company holidays) and be no longer than one year.' });
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
        return businessDays(overlapStart, overlapEnd, holidays) > 0;
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
            (total, request) => total + businessDaysForYear(request.startDate, request.endDate, year, holidays),
            0,
          );
          const available = Math.max(0, availableBalance(balance, quota) - pendingDays);
          const requestedDays = businessDaysForYear(parsed.data.startDate, parsed.data.endDate, year, holidays);
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
      leaveBalance: getBalance(result.currentYearBalance, result.pendingRequests, holidays),
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
        const currentHolidays = holidayDates(await tx.select().from(companyHolidays));
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
          const requestedDays = businessDaysForYear(record.startDate, record.endDate, year, currentHolidays);
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
          days: businessDays(record.startDate, record.endDate, currentHolidays),
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
      leaveBalance: getBalance(
        result.currentYearBalance,
        result.pendingRequests,
        holidayDates(await db.select().from(companyHolidays)),
      ),
    };
  });
}
