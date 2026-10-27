import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { db } from '../db/index.js';
import { appraisalReviews, employees } from '../db/schema.js';

const cycleSchema = z.object({
  cycle: z.string().trim().min(2).max(100),
});
const selfAssessmentSchema = z.object({
  rating: z.number().finite().min(1).max(5).multipleOf(0.1),
  comments: z.string().trim().min(1).max(5000),
  goals: z.string().trim().min(1).max(5000),
});
const managerReviewSchema = z.object({
  rating: z.number().finite().min(1).max(5).multipleOf(0.1),
  comments: z.string().trim().min(1).max(5000),
});

async function getUser(request: FastifyRequest, reply: FastifyReply): Promise<PublicUser | null> {
  const user = await authenticate(request);
  if (!user) {
    await reply.code(401).send({ error: 'Authentication required.' });
    return null;
  }
  return user;
}

async function shapeReviews(records: Array<typeof appraisalReviews.$inferSelect>) {
  if (!records.length) return [];
  const employeeIds = [...new Set(records.map(record => record.employeeId))];
  const employeeRecords = await db.select().from(employees)
    .where(inArray(employees.id, employeeIds));
  const employeesById = new Map(employeeRecords.map(employee => [employee.id, employee]));

  return records.map(record => {
    const employee = employeesById.get(record.employeeId);
    if (!employee) throw new Error(`Appraisal ${record.id} references a missing employee.`);
    return {
      id: record.id,
      employeeId: employee.id,
      employeeName: `${employee.firstName} ${employee.lastName}`,
      employeeAvatar: employee.avatar,
      department: employee.department,
      designation: employee.designation,
      cycle: record.cycle,
      status: record.status,
      ...(record.overallRating !== null ? { overallRating: record.overallRating } : {}),
      ...(record.selfRating !== null ? { selfRating: record.selfRating } : {}),
      ...(record.managerRating !== null ? { managerRating: record.managerRating } : {}),
      ...(record.selfComments ? { selfComments: record.selfComments } : {}),
      ...(record.managerComments ? { managerComments: record.managerComments } : {}),
      ...(record.goalsAchieved ? { goalsAchieved: record.goalsAchieved } : {}),
      ...(record.completedDate ? { completedDate: record.completedDate } : {}),
    };
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23505';
}

export async function registerAppraisalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;

    let records: Array<typeof appraisalReviews.$inferSelect>;
    if (user.role === 'admin') {
      records = await db.select().from(appraisalReviews)
        .orderBy(desc(appraisalReviews.createdAt), asc(appraisalReviews.employeeId));
    } else {
      const [employee] = await db.select({ id: employees.id }).from(employees)
        .where(eq(employees.userId, user.id)).limit(1);
      if (!employee) return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });
      records = await db.select().from(appraisalReviews)
        .where(eq(appraisalReviews.employeeId, employee.id))
        .orderBy(desc(appraisalReviews.createdAt));
    }
    return { appraisals: await shapeReviews(records) };
  });

  app.post('/cycles', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const parsed = cycleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a review cycle name between 2 and 100 characters.' });

    const activeEmployees = await db.select({ id: employees.id })
      .from(employees)
      .where(eq(employees.status, 'Active'));
    if (!activeEmployees.length) return reply.code(400).send({ error: 'There are no active employees to include in a cycle.' });

    try {
      const records = await db.insert(appraisalReviews).values(activeEmployees.map(employee => ({
        employeeId: employee.id,
        cycle: parsed.data.cycle,
      }))).returning();
      return reply.code(201).send({ appraisals: await shapeReviews(records) });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'A review cycle with this name already exists for one or more employees.' });
      }
      throw error;
    }
  });

  app.patch('/:id/self-assessment', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'employee') return reply.code(403).send({ error: 'Employee access required to submit a self-assessment.' });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = selfAssessmentSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'Invalid appraisal ID.' });
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a valid rating, reflection, and achievements.' });
    const [employee] = await db.select({ id: employees.id }).from(employees)
      .where(eq(employees.userId, user.id)).limit(1);
    if (!employee) return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });

    const [record] = await db.update(appraisalReviews).set({
      selfRating: parsed.data.rating,
      selfComments: parsed.data.comments,
      goalsAchieved: parsed.data.goals,
      status: 'Manager Review',
      updatedAt: new Date(),
    }).where(and(
      eq(appraisalReviews.id, params.data.id),
      eq(appraisalReviews.employeeId, employee.id),
      eq(appraisalReviews.status, 'Self Assessment'),
    )).returning();
    if (!record) return reply.code(409).send({ error: 'This review is unavailable or the self-assessment has already been submitted.' });
    return { appraisal: (await shapeReviews([record]))[0] };
  });

  app.patch('/:id/manager-review', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = managerReviewSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'Invalid appraisal ID.' });
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a valid manager rating and review.' });

    const record = await db.transaction(async tx => {
      const [existing] = await tx.select().from(appraisalReviews)
        .where(and(
          eq(appraisalReviews.id, params.data.id),
          eq(appraisalReviews.status, 'Manager Review'),
        )).limit(1);
      if (!existing) return null;
      const [updated] = await tx.update(appraisalReviews).set({
        managerRating: parsed.data.rating,
        managerComments: parsed.data.comments,
        overallRating: Math.round((((existing.selfRating ?? parsed.data.rating) + parsed.data.rating) / 2) * 10) / 10,
        status: 'Completed',
        completedByUserId: user.id,
        completedDate: new Date().toISOString().slice(0, 10),
        updatedAt: new Date(),
      }).where(and(
        eq(appraisalReviews.id, params.data.id),
        eq(appraisalReviews.status, 'Manager Review'),
      )).returning();
      return updated ?? null;
    });
    if (!record) return reply.code(409).send({ error: 'Only reviews with a submitted self-assessment can be completed.' });
    return { appraisal: (await shapeReviews([record]))[0] };
  });
}
