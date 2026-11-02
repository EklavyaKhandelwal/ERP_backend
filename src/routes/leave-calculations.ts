import type { companyHolidays, employeeLeaveBalances, leaveRequests } from '../db/schema.js';

export type LeaveType =
  | 'Annual Leave'
  | 'Sick Leave'
  | 'Casual Leave'
  | 'Maternity/Paternity'
  | 'Unpaid Leave';
export type LeaveRecord = typeof leaveRequests.$inferSelect;
export type HolidayRecord = typeof companyHolidays.$inferSelect;
export type YearBalanceRecord = typeof employeeLeaveBalances.$inferSelect;
export type LeaveBalance = {
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
export type BalanceField = 'annualBalance' | 'sickBalance' | 'casualBalance';

export function businessDays(startDate: string, endDate: string, holidays: Set<string> = new Set()): number {
  const current = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  let count = 0;

  while (current <= end) {
    const day = current.getUTCDay();
    if (day !== 0 && day !== 6 && !holidays.has(current.toISOString().slice(0, 10))) count += 1;
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return count;
}

export function businessDaysForYear(
  startDate: string,
  endDate: string,
  year: number,
  holidays: Set<string> = new Set(),
): number {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const clippedStart = startDate > yearStart ? startDate : yearStart;
  const clippedEnd = endDate < yearEnd ? endDate : yearEnd;
  return clippedStart <= clippedEnd ? businessDays(clippedStart, clippedEnd, holidays) : 0;
}

export function holidayDates(records: HolidayRecord[]): Set<string> {
  const dates = new Set<string>();
  for (const holiday of records) {
    const current = new Date(`${holiday.startDate}T00:00:00.000Z`);
    const end = new Date(`${holiday.endDate}T00:00:00.000Z`);
    while (current <= end) {
      dates.add(current.toISOString().slice(0, 10));
      current.setUTCDate(current.getUTCDate() + 1);
    }
  }
  return dates;
}

export function requestYears(startDate: string, endDate: string): number[] {
  const firstYear = Number(startDate.slice(0, 4));
  const lastYear = Number(endDate.slice(0, 4));
  return Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index);
}

export function getBalance(
  record: YearBalanceRecord,
  requests: LeaveRecord[] = [],
  holidays: Set<string> = new Set(),
): LeaveBalance {
  const pendingDays = (type: LeaveType) => requests
    .filter(request => request.status === 'Pending' && request.leaveType === type)
    .reduce((total, request) => total + businessDaysForYear(request.startDate, request.endDate, record.year, holidays), 0);
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

export function balanceField(type: LeaveType): BalanceField | null {
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

export function availableBalance(balance: YearBalanceRecord, field: BalanceField): number {
  switch (field) {
    case 'annualBalance': return balance.annualBalance;
    case 'sickBalance': return balance.sickBalance;
    case 'casualBalance': return balance.casualBalance;
  }
}
