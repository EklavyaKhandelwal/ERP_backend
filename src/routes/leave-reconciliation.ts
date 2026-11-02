import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companyHolidays, employeeLeaveBalances, employees, leaveRequests, users } from '../db/schema.js';
import { insertUserNotifications } from '../notifications.js';
import {
  balanceField,
  businessDays,
  businessDaysForYear,
  holidayDates,
  requestYears,
} from './leave-calculations.js';

type LeaveExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function holidayRecipients(executor: LeaveExecutor): Promise<string[]> {
  const records = await executor.select({ userId: employees.userId })
    .from(employees)
    .innerJoin(users, eq(employees.userId, users.id))
    .where(and(eq(users.role, 'employee'), eq(users.isActive, true)));
  return [...new Set(records.flatMap(record => record.userId ? [record.userId] : []))];
}

export async function notifyHolidayChange(executor: LeaveExecutor, message: string): Promise<void> {
  await insertUserNotifications(executor, await holidayRecipients(executor), message);
}

export async function reconcileLeaveBalancesForHolidayChange(
  executor: LeaveExecutor,
  startDate: string,
  endDate: string,
): Promise<void> {
  const affected = await executor.select().from(leaveRequests).where(and(
    lte(leaveRequests.startDate, endDate),
    gte(leaveRequests.endDate, startDate),
  ));
  if (!affected.length) return;

  const holidays = holidayDates(await executor.select().from(companyHolidays));
  const affectedEmployees = new Map<string, Set<number>>();
  const updatedRequests: Array<{ id: string; days: number }> = [];
  for (const request of affected) {
    const days = businessDays(request.startDate, request.endDate, holidays);
    if (days !== request.days) updatedRequests.push({ id: request.id, days });
    if (request.status === 'Approved' && balanceField(request.leaveType)) {
      const years = affectedEmployees.get(request.employeeId) ?? new Set<number>();
      requestYears(request.startDate, request.endDate).forEach(year => years.add(year));
      affectedEmployees.set(request.employeeId, years);
    }
  }

  const batchSize = 500;
  for (let offset = 0; offset < updatedRequests.length; offset += batchSize) {
    const batch = updatedRequests.slice(offset, offset + batchSize);
    await executor.update(leaveRequests).set({
      days: sql`case ${leaveRequests.id} ${sql.join(
        batch.map(request => sql`when ${request.id} then ${request.days}`),
        sql` `,
      )} else ${leaveRequests.days} end`,
      updatedAt: new Date(),
    }).where(inArray(leaveRequests.id, batch.map(request => request.id)));
  }

  if (!affectedEmployees.size) return;
  const employeeIds = [...affectedEmployees.keys()];
  const years = [...new Set([...affectedEmployees.values()].flatMap(employeeYears => [...employeeYears]))];
  const [balances, approvedRequests] = await Promise.all([
    executor.select().from(employeeLeaveBalances).where(and(
      inArray(employeeLeaveBalances.employeeId, employeeIds),
      inArray(employeeLeaveBalances.year, years),
    )),
    executor.select().from(leaveRequests).where(and(
      inArray(leaveRequests.employeeId, employeeIds),
      eq(leaveRequests.status, 'Approved'),
    )),
  ]);
  const requestsByEmployee = new Map<string, typeof approvedRequests>();
  for (const request of approvedRequests) {
    requestsByEmployee.set(request.employeeId, [
      ...(requestsByEmployee.get(request.employeeId) ?? []),
      request,
    ]);
  }
  const balanceUpdates = balances.flatMap(balance => {
    if (!affectedEmployees.get(balance.employeeId)?.has(balance.year)) return [];
    let annualUsed = 0;
    let sickUsed = 0;
    let casualUsed = 0;
    for (const request of requestsByEmployee.get(balance.employeeId) ?? []) {
      const days = businessDaysForYear(request.startDate, request.endDate, balance.year, holidays);
      if (request.leaveType === 'Annual Leave') annualUsed += days;
      if (request.leaveType === 'Sick Leave') sickUsed += days;
      if (request.leaveType === 'Casual Leave') casualUsed += days;
    }
    return [{
      id: balance.id,
      annualBalance: Math.max(0, balance.annualTotal - annualUsed),
      sickBalance: Math.max(0, balance.sickTotal - sickUsed),
      casualBalance: Math.max(0, balance.casualTotal - casualUsed),
    }];
  });
  for (let offset = 0; offset < balanceUpdates.length; offset += batchSize) {
    const batch = balanceUpdates.slice(offset, offset + batchSize);
    const caseFor = (field: 'annualBalance' | 'sickBalance' | 'casualBalance') => sql`case ${employeeLeaveBalances.id} ${sql.join(
      batch.map(balance => sql`when ${balance.id} then ${balance[field]}`),
      sql` `,
    )} else ${employeeLeaveBalances[field]} end`;
    await executor.update(employeeLeaveBalances).set({
      annualBalance: caseFor('annualBalance'),
      sickBalance: caseFor('sickBalance'),
      casualBalance: caseFor('casualBalance'),
      updatedAt: new Date(),
    }).where(inArray(employeeLeaveBalances.id, batch.map(balance => balance.id)));
  }
}
