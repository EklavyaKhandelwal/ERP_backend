import { and, asc, count, desc, eq, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { db } from '../db/index.js';
import {
  employees,
  employeeLeaveBalances,
  leavePolicies,
  leaveRequests,
  payrollRecords,
  payrollRuns,
  projectTasks,
  projectMembers,
  projects,
  timesheetEntries,
  timesheets,
  users,
} from '../db/schema.js';

async function getAuthenticatedUser(request: FastifyRequest, reply: FastifyReply): Promise<PublicUser | null> {
  const user = await authenticate(request);
  if (!user) {
    await reply.code(401).send({ error: 'Authentication required.' });
    return null;
  }
  return user;
}

async function getUser(request: FastifyRequest, reply: FastifyReply): Promise<PublicUser | null> {
  const user = await getAuthenticatedUser(request, reply);
  if (user && user.role !== 'admin') {
    await reply.code(403).send({ error: 'Administrator access required.' });
    return null;
  }
  return user;
}

async function getAdmin(request: FastifyRequest, reply: FastifyReply): Promise<PublicUser | null> {
  const user = await getUser(request, reply);
  return user;
}

function businessDays(startDate: string, endDate: string): number {
  const current = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  let total = 0;
  while (current <= end) {
    const weekday = current.getUTCDay();
    if (weekday !== 0 && weekday !== 6) total += 1;
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return total;
}

function businessDaysForYear(startDate: string, endDate: string, year: number): number {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const clippedStart = startDate > yearStart ? startDate : yearStart;
  const clippedEnd = endDate < yearEnd ? endDate : yearEnd;
  return clippedStart <= clippedEnd ? businessDays(clippedStart, clippedEnd) : 0;
}

function mondayOf(date: string): string {
  const monday = new Date(`${date}T00:00:00.000Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

function leaveQueueQuery(status: 'Pending' | 'Approved', today: string) {
  const filters = status === 'Pending'
    ? [eq(leaveRequests.status, status)]
    : [eq(leaveRequests.status, status), gte(leaveRequests.startDate, today)];

  return db.select({
    id: leaveRequests.id,
    employeeId: employees.id,
    employeeName: sql<string>`concat(${employees.firstName}, ' ', ${employees.lastName})`,
    employeeAvatar: employees.avatar,
    department: employees.department,
    leaveType: leaveRequests.leaveType,
    startDate: leaveRequests.startDate,
    endDate: leaveRequests.endDate,
    days: leaveRequests.days,
    reason: leaveRequests.reason,
    status: leaveRequests.status,
    appliedOn: leaveRequests.appliedOn,
    reviewNote: leaveRequests.reviewNote,
    createdAt: leaveRequests.createdAt,
  })
    .from(leaveRequests)
    .innerJoin(employees, eq(leaveRequests.employeeId, employees.id))
    .where(and(...filters))
    .orderBy(asc(leaveRequests.startDate), asc(leaveRequests.createdAt))
    .limit(5);
}

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/employee-summary', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getAuthenticatedUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'employee') {
      return reply.code(403).send({ error: 'Employee dashboard access required.' });
    }

    const query = z.object({ today: z.string().date() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Provide today as a valid calendar date.' });
    const { today } = query.data;
    const year = Number(today.slice(0, 4));
    const weekStart = mondayOf(today);
    const [employee] = await db.select({
      id: employees.id,
      annualLeave: employees.annualLeave,
      annualLeaveTotal: employees.annualLeaveTotal,
      sickLeave: employees.sickLeave,
      sickLeaveTotal: employees.sickLeaveTotal,
      casualLeave: employees.casualLeave,
      casualLeaveTotal: employees.casualLeaveTotal,
      dateOfBirth: employees.dateOfBirth,
    }).from(employees)
      .where(eq(employees.userId, user.id))
      .limit(1);
    if (!employee) {
      return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });
    }

    const [balanceRows, policyRows, pendingLeaveRows, upcomingLeaveRows, projectRows, timesheetRows, payslipRows] = await Promise.all([
      db.select().from(employeeLeaveBalances)
        .where(and(
          eq(employeeLeaveBalances.employeeId, employee.id),
          eq(employeeLeaveBalances.year, year),
        ))
        .limit(1),
      db.select().from(leavePolicies)
        .where(eq(leavePolicies.id, 1))
        .limit(1),
      db.select({
        id: leaveRequests.id,
        employeeId: employees.id,
        employeeName: sql<string>`concat(${employees.firstName}, ' ', ${employees.lastName})`,
        employeeAvatar: employees.avatar,
        department: employees.department,
        leaveType: leaveRequests.leaveType,
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
        days: leaveRequests.days,
        reason: leaveRequests.reason,
        status: leaveRequests.status,
        appliedOn: leaveRequests.appliedOn,
        reviewNote: leaveRequests.reviewNote,
      })
        .from(leaveRequests)
        .innerJoin(employees, eq(leaveRequests.employeeId, employees.id))
        .where(and(
          eq(leaveRequests.employeeId, employee.id),
          eq(leaveRequests.status, 'Pending'),
        ))
        .orderBy(desc(leaveRequests.appliedOn), desc(leaveRequests.createdAt)),
      db.select({
        id: leaveRequests.id,
        employeeId: employees.id,
        employeeName: sql<string>`concat(${employees.firstName}, ' ', ${employees.lastName})`,
        employeeAvatar: employees.avatar,
        department: employees.department,
        leaveType: leaveRequests.leaveType,
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
        days: leaveRequests.days,
        reason: leaveRequests.reason,
        status: leaveRequests.status,
        appliedOn: leaveRequests.appliedOn,
        reviewNote: leaveRequests.reviewNote,
      })
        .from(leaveRequests)
        .innerJoin(employees, eq(leaveRequests.employeeId, employees.id))
        .where(and(
          eq(leaveRequests.employeeId, employee.id),
          eq(leaveRequests.status, 'Approved'),
          gte(leaveRequests.endDate, today),
        ))
        .orderBy(asc(leaveRequests.startDate))
        .limit(1),
      db.select({
        id: projects.id,
        name: projects.name,
        code: projects.code,
        status: projects.status,
        progress: projects.progress,
        deadline: projects.deadline,
        activeCount: sql<number>`count(*) over ()::int`,
      })
        .from(projectMembers)
        .innerJoin(projects, eq(projectMembers.projectId, projects.id))
        .where(and(
          eq(projectMembers.employeeId, employee.id),
          inArray(projects.status, ['Active', 'In Progress']),
        ))
        .orderBy(asc(projects.deadline), asc(projects.name))
        .limit(3),
      db.select({
        id: timesheets.id,
        weekStart: timesheets.weekStart,
        status: timesheets.status,
        totalHours: sql<number>`coalesce(sum(
          coalesce((${timesheetEntries.hours}->>'mon')::numeric, 0) +
          coalesce((${timesheetEntries.hours}->>'tue')::numeric, 0) +
          coalesce((${timesheetEntries.hours}->>'wed')::numeric, 0) +
          coalesce((${timesheetEntries.hours}->>'thu')::numeric, 0) +
          coalesce((${timesheetEntries.hours}->>'fri')::numeric, 0) +
          coalesce((${timesheetEntries.hours}->>'sat')::numeric, 0) +
          coalesce((${timesheetEntries.hours}->>'sun')::numeric, 0)
        ), 0)::float`,
      })
        .from(timesheets)
        .leftJoin(timesheetEntries, eq(timesheetEntries.timesheetId, timesheets.id))
        .where(and(
          eq(timesheets.employeeId, employee.id),
          eq(timesheets.weekStart, weekStart),
        ))
        .groupBy(timesheets.id)
        .limit(1),
      db.select({
        period: payrollRuns.payPeriod,
        netPay: payrollRecords.netPay,
        status: payrollRecords.status,
      })
        .from(payrollRecords)
        .innerJoin(payrollRuns, eq(payrollRecords.runId, payrollRuns.id))
        .where(and(
          eq(payrollRecords.employeeId, employee.id),
          eq(payrollRecords.payslipStatus, 'Published'),
        ))
        .orderBy(desc(payrollRuns.payPeriod))
        .limit(1),
    ]);

    const [balance] = balanceRows;
    const [policy] = policyRows;
    const pendingDays = (leaveType: 'Annual Leave' | 'Sick Leave' | 'Casual Leave') => pendingLeaveRows
      .filter(leave => leave.leaveType === leaveType)
      .reduce((total, leave) => total + businessDaysForYear(leave.startDate, leave.endDate, year), 0);
    const [pendingLeave] = pendingLeaveRows;
    const [upcomingLeave] = upcomingLeaveRows;
    const [timesheet] = timesheetRows;
    const [payslip] = payslipRows;

    return {
      leaveBalance: {
        year,
        annual: balance?.annualBalance ?? policy?.annualDays ?? employee.annualLeave,
        annualTotal: balance?.annualTotal ?? policy?.annualDays ?? employee.annualLeaveTotal,
        annualPending: pendingDays('Annual Leave'),
        sick: balance?.sickBalance ?? policy?.sickDays ?? employee.sickLeave,
        sickTotal: balance?.sickTotal ?? policy?.sickDays ?? employee.sickLeaveTotal,
        sickPending: pendingDays('Sick Leave'),
        casual: balance?.casualBalance ?? policy?.casualDays ?? employee.casualLeave,
        casualTotal: balance?.casualTotal ?? policy?.casualDays ?? employee.casualLeaveTotal,
        casualPending: pendingDays('Casual Leave'),
      },
      leaves: {
        pendingCount: pendingLeaveRows.length,
        pending: pendingLeave ?? null,
        upcoming: upcomingLeave ?? null,
      },
      projects: {
        activeCount: projectRows[0]?.activeCount ?? 0,
        records: projectRows.map(({ activeCount: _activeCount, ...project }) => project),
      },
      timesheet: timesheet ?? null,
      birthday: {
        isToday: employee.dateOfBirth?.slice(5) === today.slice(5),
      },
      payslip: payslip ? {
        month: new Date(`${payslip.period}T00:00:00.000Z`).toLocaleString('en', { month: 'long', timeZone: 'UTC' }),
        year: Number(payslip.period.slice(0, 4)),
        netPay: payslip.netPay,
        status: payslip.status,
      } : null,
    };
  });

  app.get('/summary', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getAdmin(request, reply);
    if (!user) return reply;

    const query = z.object({ today: z.string().date() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Provide today as a valid calendar date.' });
    const { today } = query.data;
    const [employeeRows, projectRows, pendingLeaveCount, pendingLeaves, upcomingLeaves, pendingTimesheetCount, pendingTimesheets, payrollRows, birthdays] = await Promise.all([
      db.select({
        department: employees.department,
        status: employees.status,
        count: count(),
      })
        .from(employees)
        .leftJoin(users, eq(employees.userId, users.id))
        .where(or(isNull(users.id), ne(users.role, 'admin')))
        .groupBy(employees.department, employees.status),
      db.select({
        id: projects.id,
        totalTasks: count(projectTasks.id),
        completedTasks: sql<number>`count(${projectTasks.id}) filter (where ${projectTasks.status} = 'Done')`,
      })
        .from(projects)
        .leftJoin(projectTasks, eq(projectTasks.projectId, projects.id))
        .where(inArray(projects.status, ['Active', 'In Progress']))
        .groupBy(projects.id),
      db.select({ count: count() })
        .from(leaveRequests)
        .where(eq(leaveRequests.status, 'Pending')),
      leaveQueueQuery('Pending', today),
      leaveQueueQuery('Approved', today),
      db.select({ count: count() })
        .from(timesheets)
        .where(eq(timesheets.status, 'Submitted')),
      db.select({
        id: timesheets.id,
        employeeName: sql<string>`concat(${employees.firstName}, ' ', ${employees.lastName})`,
        employeeAvatar: employees.avatar,
        department: employees.department,
        weekStart: timesheets.weekStart,
        submittedOn: timesheets.submittedOn,
        workCompleted: timesheets.workCompleted,
        totalHours: sql<number>`coalesce(sum(
          coalesce((${timesheetEntries.hours}->>'mon')::numeric, 0) +
          coalesce((${timesheetEntries.hours}->>'tue')::numeric, 0) +
          coalesce((${timesheetEntries.hours}->>'wed')::numeric, 0) +
          coalesce((${timesheetEntries.hours}->>'thu')::numeric, 0) +
          coalesce((${timesheetEntries.hours}->>'fri')::numeric, 0) +
          coalesce((${timesheetEntries.hours}->>'sat')::numeric, 0) +
          coalesce((${timesheetEntries.hours}->>'sun')::numeric, 0)
        ), 0)::float`,
      })
        .from(timesheets)
        .innerJoin(employees, eq(timesheets.employeeId, employees.id))
        .leftJoin(timesheetEntries, eq(timesheetEntries.timesheetId, timesheets.id))
        .where(eq(timesheets.status, 'Submitted'))
        .groupBy(timesheets.id, employees.id)
        .orderBy(sql`${timesheets.submittedOn} desc nulls last`, desc(timesheets.weekStart))
        .limit(5),
      db.select({
        period: payrollRuns.payPeriod,
        netPay: sql<number>`coalesce(sum(${payrollRecords.netPay}), 0)::float`,
      })
        .from(payrollRuns)
        .innerJoin(payrollRecords, eq(payrollRecords.runId, payrollRuns.id))
        .where(eq(payrollRecords.payslipStatus, 'Published'))
        .groupBy(payrollRuns.payPeriod)
        .orderBy(desc(payrollRuns.payPeriod))
        .limit(1),
      db.select({
        id: employees.id,
        name: sql<string>`concat(${employees.firstName}, ' ', ${employees.lastName})`,
        avatar: employees.avatar,
      })
        .from(employees)
        .leftJoin(users, eq(employees.userId, users.id))
        .where(and(
          ne(employees.status, 'Inactive'),
          or(isNull(users.id), ne(users.role, 'admin')),
          sql`to_char(${employees.dateOfBirth}::date, 'MM-DD') = ${today.slice(5)}`,
        ))
        .orderBy(asc(employees.firstName), asc(employees.lastName)),
    ]);

    const departmentCounts = new Map<string, number>();
    let employeeCount = 0;
    let activeEmployeeCount = 0;
    for (const row of employeeRows) {
      employeeCount += row.count;
      if (row.status !== 'Inactive') {
        activeEmployeeCount += row.count;
        departmentCounts.set(row.department, (departmentCounts.get(row.department) ?? 0) + row.count);
      }
    }

    const activeProjectProgress = projectRows.map(project => (
      project.totalTasks > 0 ? Math.round((project.completedTasks / project.totalTasks) * 100) : 0
    ));
    const [latestPayroll] = payrollRows;
    const [pendingLeavesTotal] = pendingLeaveCount;
    const [pendingTimesheetsTotal] = pendingTimesheetCount;

    return {
      employees: {
        total: employeeCount,
        active: activeEmployeeCount,
        departments: [...departmentCounts]
          .map(([department, employees]) => ({ department, count: employees }))
          .sort((a, b) => b.count - a.count || a.department.localeCompare(b.department)),
      },
      projects: {
        active: projectRows.length,
        averageProgress: activeProjectProgress.length
          ? Math.round(activeProjectProgress.reduce((total, progress) => total + progress, 0) / activeProjectProgress.length)
          : null,
      },
      leaves: {
        pendingCount: pendingLeavesTotal?.count ?? 0,
        pending: pendingLeaves,
        upcoming: upcomingLeaves,
      },
      timesheets: {
        pendingCount: pendingTimesheetsTotal?.count ?? 0,
        pending: pendingTimesheets,
      },
      payroll: latestPayroll
        ? { period: latestPayroll.period.slice(0, 7), netPay: latestPayroll.netPay }
        : { period: null, netPay: null },
      birthdays,
    };
  });
}
