import { and, eq, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { env } from './env.js';
import { db } from './db/index.js';
import { employees, salesAccounts, salesActivities, users } from './db/schema.js';
import { insertUserNotifications } from './notifications.js';
import {
  getCompanyDateAndHour,
  isSalesFollowUpDigestWindowOpen,
  salesFollowUpDigestTitle,
} from './sales-follow-up-notification-utils.js';

const sweepIntervalMs = 15 * 60 * 1000;

async function sendSalesFollowUpDigests(now: Date): Promise<void> {
  const { date, hour } = getCompanyDateAndHour(now, env.COMPANY_TIME_ZONE);
  if (!isSalesFollowUpDigestWindowOpen(hour)) return;

  const owners = await db.select({
    userId: users.id,
    overdueCount: sql<number>`count(*) filter (where ${salesActivities.nextFollowUpDate} < ${date})::int`,
    dueTodayCount: sql<number>`count(*) filter (where ${salesActivities.nextFollowUpDate} = ${date})::int`,
  }).from(salesActivities)
    .innerJoin(salesAccounts, eq(salesActivities.accountId, salesAccounts.id))
    .innerJoin(employees, eq(salesAccounts.ownerEmployeeId, employees.id))
    .innerJoin(users, eq(employees.userId, users.id))
    .where(and(
      lte(salesActivities.nextFollowUpDate, date),
      eq(users.isActive, true),
      or(eq(users.role, 'admin'), eq(users.salesAccess, true)),
    ))
    .groupBy(users.id);

  await Promise.all(owners.map(owner => insertUserNotifications(
    db,
    [owner.userId],
    salesFollowUpDigestTitle(owner.overdueCount, owner.dueTodayCount),
    'salesFollowUps',
    `sales-follow-ups:${date}`,
  )));
}

export function registerSalesFollowUpNotificationSweep(app: FastifyInstance): void {
  let interval: ReturnType<typeof setInterval> | undefined;
  const runSweep = () => {
    void sendSalesFollowUpDigests(new Date())
      .catch(error => app.log.error({ err: error }, 'Sales follow-up notification sweep failed'));
  };

  app.addHook('onReady', async () => {
    runSweep();
    interval = setInterval(runSweep, sweepIntervalMs);
  });

  app.addHook('onClose', async () => {
    if (interval) clearInterval(interval);
  });
}
