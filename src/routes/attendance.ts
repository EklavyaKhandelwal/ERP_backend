import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { env } from '../env.js';
import { db } from '../db/index.js';
import { attendanceAdjustments, attendanceRecords, employees, users } from '../db/schema.js';

const dateSchema = z.string().date();
const adjustmentSchema = z.object({
  clockInAt: z.string().datetime({ offset: true }),
  clockOutAt: z.string().datetime({ offset: true }).nullable(),
  reason: z.string().trim().min(1).max(1000),
}).strict();

async function getUser(request: FastifyRequest, reply: FastifyReply): Promise<PublicUser | null> {
  const user = await authenticate(request);
  if (!user) {
    await reply.code(401).send({ error: 'Authentication required.' });
    return null;
  }
  return user;
}

async function linkedEmployee(userId: string) {
  const [employee] = await db.select().from(employees).where(eq(employees.userId, userId)).limit(1);
  return employee ?? null;
}

function companyDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: env.COMPANY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function registerAttendanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;

    const query = z.object({
      startDate: dateSchema.optional(),
      endDate: dateSchema.optional(),
      employeeId: z.string().uuid().optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Provide valid attendance filters.' });

    const endDate = query.data.endDate ?? companyDate(new Date());
    const startDate = query.data.startDate ?? endDate;
    if (startDate > endDate) {
      return reply.code(400).send({ error: 'Start date must be on or before end date.' });
    }

    const ownEmployee = await linkedEmployee(user.id);
    if (user.role === 'employee' && !ownEmployee) {
      return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });
    }

    const dateFilter = and(
      sql`(${attendanceRecords.clockInAt} AT TIME ZONE ${env.COMPANY_TIME_ZONE})::date >= ${startDate}::date`,
      sql`(${attendanceRecords.clockInAt} AT TIME ZONE ${env.COMPANY_TIME_ZONE})::date <= ${endDate}::date`,
    );
    const filters = [or(dateFilter, sql`${attendanceRecords.clockOutAt} IS NULL`)];
    if (user.role === 'employee' && ownEmployee) {
      filters.push(eq(attendanceRecords.employeeId, ownEmployee.id));
    } else if (query.data.employeeId) {
      filters.push(eq(attendanceRecords.employeeId, query.data.employeeId));
    }

    const records = await db.select({
      record: attendanceRecords,
      employee: employees,
    }).from(attendanceRecords)
      .innerJoin(employees, eq(attendanceRecords.employeeId, employees.id))
      .where(and(...filters))
      .orderBy(desc(attendanceRecords.clockInAt))
      .limit(500);
    const recordIds = records.map(row => row.record.id);
    const changes = recordIds.length
      ? await db.select({
        adjustment: attendanceAdjustments,
        changedBy: users.name,
      }).from(attendanceAdjustments)
        .innerJoin(users, eq(attendanceAdjustments.changedByUserId, users.id))
        .where(inArray(attendanceAdjustments.attendanceRecordId, recordIds))
        .orderBy(desc(attendanceAdjustments.createdAt))
      : [];
    const changesByRecord = new Map<string, typeof changes>();
    for (const change of changes) {
      changesByRecord.set(change.adjustment.attendanceRecordId, [
        ...(changesByRecord.get(change.adjustment.attendanceRecordId) ?? []),
        change,
      ]);
    }

    const ownActiveRecord = ownEmployee
      ? await db.select().from(attendanceRecords)
        .where(and(eq(attendanceRecords.employeeId, ownEmployee.id), sql`${attendanceRecords.clockOutAt} IS NULL`))
        .orderBy(desc(attendanceRecords.clockInAt))
        .limit(1)
      : [];

    return {
      timeZone: env.COMPANY_TIME_ZONE,
      todayDate: companyDate(new Date()),
      serverNow: new Date().toISOString(),
      canClock: ownEmployee !== null,
      truncated: records.length === 500,
      records: records.map(({ record, employee }) => ({
        id: record.id,
        employeeId: employee.id,
        employeeName: `${employee.firstName} ${employee.lastName}`,
        employeeCode: employee.employeeNumber,
        department: employee.department,
        clockInAt: record.clockInAt.toISOString(),
        clockOutAt: record.clockOutAt?.toISOString() ?? null,
        updatedAt: record.updatedAt.toISOString(),
        adjustments: user.role === 'admin'
          ? (changesByRecord.get(record.id) ?? []).map(({ adjustment, changedBy }) => ({
            id: adjustment.id,
            reason: adjustment.reason,
            changedBy,
            previousClockInAt: adjustment.previousClockInAt.toISOString(),
            previousClockOutAt: adjustment.previousClockOutAt?.toISOString() ?? null,
            newClockInAt: adjustment.newClockInAt.toISOString(),
            newClockOutAt: adjustment.newClockOutAt?.toISOString() ?? null,
            createdAt: adjustment.createdAt.toISOString(),
          }))
          : [],
      })),
      activeRecord: ownActiveRecord[0] ? {
        id: ownActiveRecord[0].id,
        clockInAt: ownActiveRecord[0].clockInAt.toISOString(),
      } : null,
    };
  });

  app.post('/clock-in', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    const employee = await linkedEmployee(user.id);
    if (!employee) return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });

    const result = await db.transaction(async tx => {
      await tx.select({ id: employees.id }).from(employees)
        .where(eq(employees.id, employee.id))
        .for('update')
        .limit(1);
      const [active] = await tx.select({ id: attendanceRecords.id })
        .from(attendanceRecords)
        .where(and(
          eq(attendanceRecords.employeeId, employee.id),
          sql`${attendanceRecords.clockOutAt} IS NULL`,
        ))
        .limit(1);
      if (active) return { error: 'You are already clocked in. Clock out before starting another attendance session.' };

      const [record] = await tx.insert(attendanceRecords).values({
        employeeId: employee.id,
        clockInAt: new Date(),
      }).returning({ id: attendanceRecords.id, clockInAt: attendanceRecords.clockInAt });
      return { record };
    });
    if ('error' in result) return reply.code(409).send({ error: result.error });
    return reply.code(201).send({
      activeRecord: { id: result.record.id, clockInAt: result.record.clockInAt.toISOString() },
    });
  });

  app.post('/clock-out', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    const employee = await linkedEmployee(user.id);
    if (!employee) return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });

    const result = await db.transaction(async tx => {
      await tx.select({ id: employees.id }).from(employees)
        .where(eq(employees.id, employee.id))
        .for('update')
        .limit(1);
      const [active] = await tx.select().from(attendanceRecords)
        .where(and(
          eq(attendanceRecords.employeeId, employee.id),
          sql`${attendanceRecords.clockOutAt} IS NULL`,
        ))
        .orderBy(desc(attendanceRecords.clockInAt))
        .for('update')
        .limit(1);
      if (!active) return { error: 'You are not currently clocked in.' };
      const clockOutAt = new Date();
      if (clockOutAt <= active.clockInAt) return { error: 'Clock-out time must be after clock-in time.' };

      const [record] = await tx.update(attendanceRecords).set({
        clockOutAt,
        updatedAt: clockOutAt,
      }).where(eq(attendanceRecords.id, active.id)).returning({
        id: attendanceRecords.id,
        clockInAt: attendanceRecords.clockInAt,
        clockOutAt: attendanceRecords.clockOutAt,
      });
      return { record };
    });
    if ('error' in result) return reply.code(409).send({ error: result.error });
    return {
      record: {
        id: result.record.id,
        clockInAt: result.record.clockInAt.toISOString(),
        clockOutAt: result.record.clockOutAt?.toISOString() ?? null,
      },
    };
  });

  app.patch('/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });

    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = adjustmentSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'Invalid attendance record ID.' });
    if (!parsed.success) return reply.code(400).send({ error: 'Provide valid clock-in and clock-out times and a correction reason.' });

    const clockInAt = new Date(parsed.data.clockInAt);
    const clockOutAt = parsed.data.clockOutAt ? new Date(parsed.data.clockOutAt) : null;
    const now = new Date();
    if (clockInAt > now || (clockOutAt && clockOutAt > now)) {
      return reply.code(400).send({ error: 'Attendance times cannot be in the future.' });
    }
    if (clockOutAt && clockOutAt <= clockInAt) {
      return reply.code(400).send({ error: 'Clock-out time must be after clock-in time.' });
    }

    const result = await db.transaction(async tx => {
      const [existing] = await tx.select().from(attendanceRecords)
        .where(eq(attendanceRecords.id, params.data.id))
        .limit(1);
      if (!existing) return { error: 'Attendance record not found.', status: 404 as const };
      await tx.select({ id: employees.id }).from(employees)
        .where(eq(employees.id, existing.employeeId))
        .for('update')
        .limit(1);
      const [record] = await tx.select().from(attendanceRecords)
        .where(eq(attendanceRecords.id, params.data.id))
        .for('update')
        .limit(1);
      if (!record) return { error: 'Attendance record not found.', status: 404 as const };
      if (record.clockInAt.getTime() === clockInAt.getTime()
        && (record.clockOutAt?.getTime() ?? null) === (clockOutAt?.getTime() ?? null)) {
        return { error: 'The submitted attendance times do not change this record.', status: 400 as const };
      }
      if (!clockOutAt) {
        const [otherOpenRecord] = await tx.select({ id: attendanceRecords.id }).from(attendanceRecords)
          .where(and(
            eq(attendanceRecords.employeeId, record.employeeId),
            sql`${attendanceRecords.clockOutAt} IS NULL`,
            sql`${attendanceRecords.id} <> ${record.id}`,
          ))
          .limit(1);
        if (otherOpenRecord) {
          return { error: 'This employee already has another open attendance record.', status: 409 as const };
        }
      }

      const [updated] = await tx.update(attendanceRecords).set({
        clockInAt,
        clockOutAt,
        updatedAt: now,
      }).where(eq(attendanceRecords.id, record.id)).returning({ id: attendanceRecords.id });
      await tx.insert(attendanceAdjustments).values({
        attendanceRecordId: record.id,
        changedByUserId: user.id,
        reason: parsed.data.reason,
        previousClockInAt: record.clockInAt,
        previousClockOutAt: record.clockOutAt,
        newClockInAt: clockInAt,
        newClockOutAt: clockOutAt,
      });
      return { recordId: updated.id };
    });
    if ('error' in result && typeof result.status === 'number') {
      return reply.code(result.status).send({ error: result.error });
    }
    return { recordId: result.recordId };
  });
}
