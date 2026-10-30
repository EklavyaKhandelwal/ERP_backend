import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth.js';
import { db } from '../db/index.js';
import { notificationPreferences, notifications } from '../db/schema.js';
import {
  defaultNotificationPreferences,
  notificationCategories,
} from '../notifications.js';

const preferencesSchema = z.object(
  Object.fromEntries(notificationCategories.map(category => [category, z.boolean()])) as Record<
    typeof notificationCategories[number],
    z.ZodBoolean
  >,
).strict();

async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await authenticate(request);
  if (!user) {
    await reply.code(401).send({ error: 'Authentication required.' });
    return null;
  }
  return user;
}

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;

    const records = await db.select({
      id: notifications.id,
      title: notifications.title,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
    }).from(notifications)
      .leftJoin(notificationPreferences, eq(notificationPreferences.userId, notifications.userId))
      .where(and(
        eq(notifications.userId, user.id),
        or(
          isNull(notifications.category),
          sql`coalesce(${notificationPreferences.preferences}->>${notifications.category}, 'true') <> 'false'`,
        ),
      ))
      .orderBy(desc(notifications.createdAt))
      .limit(50);

    return { notifications: records };
  });

  app.get('/preferences', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;

    const [record] = await db.select({
      preferences: notificationPreferences.preferences,
    }).from(notificationPreferences)
      .where(eq(notificationPreferences.userId, user.id))
      .limit(1);

    const savedPreferences = record?.preferences ?? {};
    return {
      preferences: Object.fromEntries(notificationCategories.map(category => [
        category,
        savedPreferences[category] ?? defaultNotificationPreferences[category],
      ])),
    };
  });

  app.put('/preferences', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;

    const parsed = preferencesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Provide a boolean value for every notification preference.' });
    }

    const [record] = await db.insert(notificationPreferences).values({
      userId: user.id,
      preferences: parsed.data,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: notificationPreferences.userId,
      set: { preferences: parsed.data, updatedAt: new Date() },
    }).returning({ preferences: notificationPreferences.preferences });

    return { preferences: record.preferences };
  });

  app.patch('/read', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await requireUser(request, reply);
    if (!user) return reply;

    await db.update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)));

    return reply.code(204).send();
  });
}
