import { inArray } from 'drizzle-orm';
import { db } from './db/index.js';
import { notificationPreferences, notifications } from './db/schema.js';

export const notificationCategories = [
  'leaveRequests',
  'timesheetSubmissions',
  'appraisalCycleUpdates',
  'employeeOnboarding',
  'projectMilestones',
  'salesFollowUps',
] as const;

export type NotificationCategory = typeof notificationCategories[number];
export type NotificationPreferences = Record<NotificationCategory, boolean>;

export const defaultNotificationPreferences: NotificationPreferences = {
  leaveRequests: true,
  timesheetSubmissions: true,
  appraisalCycleUpdates: true,
  employeeOnboarding: true,
  projectMilestones: false,
  salesFollowUps: true,
};

type NotificationExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function insertUserNotifications(
  executor: NotificationExecutor,
  recipientIds: string[],
  title: string,
  category?: NotificationCategory,
  dedupeKey?: string,
): Promise<void> {
  if (!recipientIds.length) return;

  let enabledRecipientIds = recipientIds;
  if (category) {
    const savedPreferences = await executor.select({
      userId: notificationPreferences.userId,
      preferences: notificationPreferences.preferences,
    }).from(notificationPreferences)
      .where(inArray(notificationPreferences.userId, recipientIds));
    const preferencesByUser = new Map(savedPreferences.map(record => [record.userId, record.preferences]));
    enabledRecipientIds = recipientIds.filter(userId => (
      (preferencesByUser.get(userId) ?? defaultNotificationPreferences)[category] !== false
    ));
  }

  if (enabledRecipientIds.length) {
    const records = enabledRecipientIds.map(userId => ({
      userId,
      title,
      category: category ?? null,
      dedupeKey: dedupeKey ? `${dedupeKey}:${userId}` : null,
    }));
    const insert = executor.insert(notifications).values(records);
    if (dedupeKey) {
      await insert.onConflictDoNothing({ target: notifications.dedupeKey });
    } else {
      await insert;
    }
  }
}
