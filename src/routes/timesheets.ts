import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { db } from '../db/index.js';
import { insertUserNotifications } from '../notifications.js';
import {
  employees,
  projectMembers,
  projects,
  timesheetEntries,
  timesheets,
  users,
} from '../db/schema.js';

const weekdayHours = z.object({
  mon: z.number().finite().min(0).max(24),
  tue: z.number().finite().min(0).max(24),
  wed: z.number().finite().min(0).max(24),
  thu: z.number().finite().min(0).max(24),
  fri: z.number().finite().min(0).max(24),
  sat: z.number().finite().min(0).max(24),
  sun: z.number().finite().min(0).max(24),
});
const weekdayDescriptions = z.object({
  mon: z.string().trim().max(500),
  tue: z.string().trim().max(500),
  wed: z.string().trim().max(500),
  thu: z.string().trim().max(500),
  fri: z.string().trim().max(500),
  sat: z.string().trim().max(500),
  sun: z.string().trim().max(500),
});
const entriesSchema = z.array(z.object({
  projectId: z.string().uuid(),
  taskDescription: z.string().trim().min(1).max(500),
  dailyDescriptions: weekdayDescriptions,
  hours: weekdayHours,
})).min(1).max(100);
const weeklySummarySchema = {
  workCompleted: z.string().trim().max(5000).default(''),
  nextWeekFocus: z.string().trim().max(5000).default(''),
  blockers: z.string().trim().max(3000).default(''),
};
const createSchema = z.object({
  weekStart: z.string().date(),
  status: z.enum(['Draft', 'Submitted']).default('Draft'),
  entries: entriesSchema,
  ...weeklySummarySchema,
});
const updateSchema = z.object({
  status: z.enum(['Draft', 'Submitted']).default('Draft'),
  entries: entriesSchema,
  ...weeklySummarySchema,
});
const reviewSchema = z.object({
  status: z.enum(['Approved', 'Rejected']),
  note: z.string().trim().max(2000).optional().default(''),
});
const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

type InputEntry = z.infer<typeof entriesSchema>[number];

function isMonday(value: string): boolean {
  return new Date(`${value}T00:00:00.000Z`).getUTCDay() === 1;
}

function totalHours(entries: InputEntry[]): number {
  return entries.reduce((total, entry) => total + days.reduce((sum, day) => sum + entry.hours[day], 0), 0);
}

function dailyTotals(entries: InputEntry[]): number[] {
  return days.map(day => entries.reduce((sum, entry) => sum + entry.hours[day], 0));
}

function validateSubmission(entries: InputEntry[], workCompleted: string, nextWeekFocus: string): string | null {
  const totals = dailyTotals(entries);
  if (totalHours(entries) <= 0) return 'Add logged hours before submitting the timesheet.';
  if (!workCompleted.trim()) return 'Describe the work completed this week before submitting.';
  if (!nextWeekFocus.trim()) return 'Describe next week’s focus before submitting.';
  for (const [index, day] of days.entries()) {
    if (totals[index] > 0 && entries.some(entry => entry.hours[day] > 0 && !entry.dailyDescriptions[day].trim())) {
      return `Add a work description for every project with hours on ${day.toUpperCase()}.`;
    }
  }
  return null;
}

async function getUser(request: FastifyRequest, reply: FastifyReply): Promise<PublicUser | null> {
  const user = await authenticate(request);
  if (!user) {
    await reply.code(401).send({ error: 'Authentication required.' });
    return null;
  }
  return user;
}

async function getEmployee(userId: string) {
  const [employee] = await db.select().from(employees).where(eq(employees.userId, userId)).limit(1);
  return employee ?? null;
}

async function validateProjects(employeeId: string, entries: InputEntry[], executor: typeof db = db): Promise<boolean> {
  const ids = [...new Set(entries.map(entry => entry.projectId))];
  const memberships = await executor.select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .where(and(
      eq(projectMembers.employeeId, employeeId),
      inArray(projectMembers.projectId, ids),
      inArray(projects.status, ['Active', 'In Progress']),
    ));
  return new Set(memberships.map(row => row.projectId)).size === ids.length;
}

async function shapeTimesheets(records: Array<typeof timesheets.$inferSelect>) {
  if (!records.length) return [];

  const employeeIds = [...new Set(records.map(record => record.employeeId))];
  const reviewerIds = [...new Set(records.flatMap(record => record.reviewedByUserId ? [record.reviewedByUserId] : []))];
  const recordIds = records.map(record => record.id);
  const [employeeRecords, reviewerRecords, entryRows] = await Promise.all([
    db.select().from(employees).where(inArray(employees.id, employeeIds)),
    reviewerIds.length
      ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, reviewerIds))
      : Promise.resolve([]),
    db.select({ entry: timesheetEntries, project: projects })
      .from(timesheetEntries)
      .innerJoin(projects, eq(timesheetEntries.projectId, projects.id))
      .where(inArray(timesheetEntries.timesheetId, recordIds))
      .orderBy(asc(projects.name), asc(timesheetEntries.taskDescription)),
  ]);
  const employeesById = new Map(employeeRecords.map(employee => [employee.id, employee]));
  const reviewersById = new Map(reviewerRecords.map(reviewer => [reviewer.id, reviewer.name]));
  const entriesByTimesheet = new Map<string, Array<{
    id: string;
    projectId: string;
    projectName: string;
    taskDescription: string;
    dailyDescriptions: typeof timesheetEntries.$inferSelect.dailyDescriptions;
    hours: typeof timesheetEntries.$inferSelect.hours;
  }>>();
  for (const { entry, project } of entryRows) {
    const timesheetEntriesForRecord = entriesByTimesheet.get(entry.timesheetId) ?? [];
    timesheetEntriesForRecord.push({
      id: entry.id,
      projectId: project.id,
      projectName: project.name,
      taskDescription: entry.taskDescription,
      dailyDescriptions: entry.dailyDescriptions,
      hours: entry.hours,
    });
    entriesByTimesheet.set(entry.timesheetId, timesheetEntriesForRecord);
  }

  return records.map(record => {
    const employee = employeesById.get(record.employeeId);
    if (!employee) throw new Error(`Timesheet ${record.id} references a missing employee.`);
    const entries = entriesByTimesheet.get(record.id) ?? [];
    const weekEnd = new Date(`${record.weekStart}T00:00:00.000Z`);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    const reviewerName = record.reviewedByUserId ? reviewersById.get(record.reviewedByUserId) : undefined;

    return {
      id: record.id,
      employeeId: employee.id,
      employeeName: `${employee.firstName} ${employee.lastName}`,
      employeeAvatar: employee.avatar,
      department: employee.department,
      weekStart: record.weekStart,
      weekEnd: weekEnd.toISOString().slice(0, 10),
      entries,
      totalHours: totalHours(entries),
      status: record.status,
      workCompleted: record.workCompleted,
      nextWeekFocus: record.nextWeekFocus,
      blockers: record.blockers,
      ...(record.submittedOn ? { submittedOn: record.submittedOn } : {}),
      ...(reviewerName ? { reviewedBy: reviewerName } : {}),
      ...(record.reviewNote ? { reviewNote: record.reviewNote } : {}),
    };
  });
}

async function shapeTimesheet(record: typeof timesheets.$inferSelect) {
  const [shaped] = await shapeTimesheets([record]);
  return shaped;
}

export async function registerTimesheetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    let records: Array<typeof timesheets.$inferSelect>;
    if (user.role === 'admin') {
      records = await db.select().from(timesheets)
        .orderBy(desc(timesheets.weekStart), desc(timesheets.createdAt));
    } else {
      const employee = await getEmployee(user.id);
      if (!employee) return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });
      records = await db.select().from(timesheets).where(eq(timesheets.employeeId, employee.id))
        .orderBy(desc(timesheets.weekStart), desc(timesheets.createdAt));
    }
    return { timesheets: await shapeTimesheets(records) };
  });

  app.post('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    const employee = await getEmployee(user.id);
    if (!employee) return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a valid week and at least one timesheet entry.' });
    const { weekStart, entries, status, workCompleted, nextWeekFocus, blockers } = parsed.data;
    if (!isMonday(weekStart)) return reply.code(400).send({ error: 'The timesheet week must start on a Monday.' });
    if (dailyTotals(entries).some(total => total > 24)) {
      return reply.code(400).send({ error: 'Logged hours cannot exceed 24 hours per day.' });
    }
    if (status === 'Submitted') {
      const submissionError = validateSubmission(entries, workCompleted, nextWeekFocus);
      if (submissionError) return reply.code(400).send({ error: submissionError });
    }
    if (!(await validateProjects(employee.id, entries))) {
      return reply.code(400).send({ error: 'Every entry must use a project assigned to you that is still active.' });
    }

    try {
      const [record] = await db.transaction(async tx => {
        const [created] = await tx.insert(timesheets).values({
          employeeId: employee.id,
          weekStart,
          status,
          submittedOn: status === 'Submitted' ? new Date().toISOString().slice(0, 10) : null,
          workCompleted,
          nextWeekFocus,
          blockers,
        }).returning();
        await tx.insert(timesheetEntries).values(entries.map(entry => ({
          timesheetId: created.id,
          projectId: entry.projectId,
          taskDescription: entry.taskDescription,
          hours: entry.hours,
          dailyDescriptions: entry.dailyDescriptions,
        })));
        if (status === 'Submitted') {
          const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));
          if (admins.length > 0) {
            await insertUserNotifications(
              tx,
              admins.map(admin => admin.id),
              `${employee.firstName} ${employee.lastName} submitted a timesheet for the week of ${weekStart}.`,
              'timesheetSubmissions',
            );
          }
        }
        return [created];
      });
      return reply.code(201).send({ timesheet: await shapeTimesheet(record) });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'A timesheet already exists for this week. Update the existing timesheet instead.' });
      }
      throw error;
    }
  });

  app.patch('/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    const employee = await getEmployee(user.id);
    if (!employee) return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = updateSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'Invalid timesheet ID.' });
    if (!parsed.success) return reply.code(400).send({ error: 'Provide valid timesheet entries.' });
    const { entries, status, workCompleted, nextWeekFocus, blockers } = parsed.data;
    if (dailyTotals(entries).some(total => total > 24)) {
      return reply.code(400).send({ error: 'Logged hours cannot exceed 24 hours per day.' });
    }
    if (status === 'Submitted') {
      const submissionError = validateSubmission(entries, workCompleted, nextWeekFocus);
      if (submissionError) return reply.code(400).send({ error: submissionError });
    }
    if (!(await validateProjects(employee.id, entries))) {
      return reply.code(400).send({ error: 'Every entry must use a project assigned to you that is still active.' });
    }

    const result = await db.transaction(async tx => {
      const [existing] = await tx.select().from(timesheets).where(and(
        eq(timesheets.id, params.data.id),
        eq(timesheets.employeeId, employee.id),
      )).for('update').limit(1);
      if (!existing) return { error: 'Timesheet not found.' as const };
      if (!['Draft', 'Rejected'].includes(existing.status)) {
        return { error: 'Only draft or rejected timesheets can be edited.' as const };
      }
      const [updated] = await tx.update(timesheets).set({
        status,
        submittedOn: status === 'Submitted' ? new Date().toISOString().slice(0, 10) : null,
        reviewedByUserId: null,
        reviewNote: null,
        workCompleted,
        nextWeekFocus,
        blockers,
        updatedAt: new Date(),
      }).where(eq(timesheets.id, existing.id)).returning();
      await tx.delete(timesheetEntries).where(eq(timesheetEntries.timesheetId, existing.id));
      await tx.insert(timesheetEntries).values(entries.map(entry => ({
        timesheetId: existing.id,
        projectId: entry.projectId,
        taskDescription: entry.taskDescription,
        hours: entry.hours,
        dailyDescriptions: entry.dailyDescriptions,
      })));
      if (status === 'Submitted') {
        const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));
        if (admins.length > 0) {
          await insertUserNotifications(
            tx,
            admins.map(admin => admin.id),
            `${employee.firstName} ${employee.lastName} submitted a timesheet for the week of ${existing.weekStart}.`,
            'timesheetSubmissions',
          );
        }
      }
      return { record: updated };
    });
    if ('error' in result) {
      return reply.code(result.error === 'Timesheet not found.' ? 404 : 409).send({ error: result.error });
    }
    return { timesheet: await shapeTimesheet(result.record) };
  });

  app.patch('/:id/review', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = reviewSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'Invalid timesheet ID.' });
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a valid review decision and note.' });
    if (parsed.data.status === 'Rejected' && !parsed.data.note.trim()) {
      return reply.code(400).send({ error: 'Add a review note before returning this timesheet.' });
    }

    const result = await db.transaction(async tx => {
      const [existing] = await tx.select().from(timesheets).where(eq(timesheets.id, params.data.id))
        .for('update').limit(1);
      if (!existing) return { error: 'Timesheet not found.' as const };
      if (existing.status !== 'Submitted') return { error: 'Only submitted timesheets can be reviewed.' as const };
      const [updated] = await tx.update(timesheets).set({
        status: parsed.data.status,
        reviewedByUserId: user.id,
        reviewNote: parsed.data.note || null,
        updatedAt: new Date(),
      }).where(eq(timesheets.id, existing.id)).returning();
      const [employee] = await tx.select().from(employees)
        .where(eq(employees.id, existing.employeeId)).limit(1);
      if (employee?.userId) {
        await insertUserNotifications(
          tx,
          [employee.userId],
          `Your timesheet for the week of ${existing.weekStart} was ${parsed.data.status.toLowerCase()}.`,
          'timesheetSubmissions',
        );
      }
      return { record: updated };
    });
    if ('error' in result) {
      return reply.code(result.error === 'Timesheet not found.' ? 404 : 409).send({ error: result.error });
    }
    return { timesheet: await shapeTimesheet(result.record) };
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23505';
}
