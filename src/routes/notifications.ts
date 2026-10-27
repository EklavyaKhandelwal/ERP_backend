import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate } from '../auth.js';
import { db } from '../db/index.js';
import { notifications } from '../db/schema.js';

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
      .where(eq(notifications.userId, user.id))
      .orderBy(desc(notifications.createdAt))
      .limit(50);

    return { notifications: records };
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
