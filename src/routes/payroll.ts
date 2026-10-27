import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { db } from '../db/index.js';
import { employees, payrollRecords, payrollRuns } from '../db/schema.js';

const amount = z.number().finite().min(0).max(1_000_000_000).multipleOf(0.01);
const runSchema = z.object({
  payPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Pay period must use YYYY-MM format.'),
  records: z.array(z.object({
    employeeId: z.string().uuid(),
    basicSalary: amount,
    hra: amount.default(0),
    specialAllowance: amount.default(0),
    bonus: amount.default(0),
    providentFund: amount.default(0),
    professionalTax: amount.default(0),
    incomeTax: amount.default(0),
  })).min(1).max(500),
});
const statusSchema = z.object({
  status: z.enum(['Pending', 'Processing', 'Paid']),
});

async function getUser(request: FastifyRequest, reply: FastifyReply): Promise<PublicUser | null> {
  const user = await authenticate(request);
  if (!user) {
    await reply.code(401).send({ error: 'Authentication required.' });
    return null;
  }
  return user;
}

async function shapeRecords(records: Array<typeof payrollRecords.$inferSelect>) {
  if (!records.length) return [];
  const employeeIds = [...new Set(records.map(record => record.employeeId))];
  const employeeRecords = await db.select().from(employees).where(inArray(employees.id, employeeIds));
  const employeesById = new Map(employeeRecords.map(employee => [employee.id, employee]));
  const runIds = [...new Set(records.map(record => record.runId))];
  const runRecords = await db.select().from(payrollRuns).where(inArray(payrollRuns.id, runIds));
  const runsById = new Map(runRecords.map(run => [run.id, run]));

  return records.map(record => {
    const employee = employeesById.get(record.employeeId);
    const run = runsById.get(record.runId);
    if (!employee || !run) throw new Error(`Payroll record ${record.id} references missing related data.`);
    const [year, monthNumber] = run.payPeriod.split('-').map(Number);
    return {
      id: record.id,
      employeeId: employee.id,
      employeeName: `${employee.firstName} ${employee.lastName}`,
      employeeCode: `EMP-${String(employee.employeeNumber).padStart(4, '0')}`,
      department: employee.department,
      designation: employee.designation,
      month: new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' }),
      year,
      basicSalary: record.basicSalary,
      hra: record.hra,
      specialAllowance: record.specialAllowance,
      bonus: record.bonus,
      providentFund: record.providentFund,
      professionalTax: record.professionalTax,
      incomeTax: record.incomeTax,
      totalEarnings: record.totalEarnings,
      totalDeductions: record.totalDeductions,
      netPay: record.netPay,
      status: record.status,
      ...(record.paymentDate ? { paymentDate: record.paymentDate } : {}),
    };
  });
}

export async function registerPayrollRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    let records: Array<typeof payrollRecords.$inferSelect>;
    if (user.role === 'admin') {
      records = await db.select().from(payrollRecords)
        .orderBy(desc(payrollRecords.createdAt), asc(payrollRecords.employeeId));
    } else {
      const [employee] = await db.select({ id: employees.id }).from(employees)
        .where(eq(employees.userId, user.id)).limit(1);
      if (!employee) return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });
      records = await db.select().from(payrollRecords).where(eq(payrollRecords.employeeId, employee.id))
        .orderBy(desc(payrollRecords.createdAt));
    }
    return { payroll: await shapeRecords(records) };
  });

  app.get('/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid payroll record ID.' });
    let record: typeof payrollRecords.$inferSelect | undefined;
    if (user.role === 'admin') {
      [record] = await db.select().from(payrollRecords)
        .where(eq(payrollRecords.id, params.data.id)).limit(1);
    } else {
      const [employee] = await db.select({ id: employees.id }).from(employees)
        .where(eq(employees.userId, user.id)).limit(1);
      if (!employee) return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });
      [record] = await db.select().from(payrollRecords)
        .where(and(eq(payrollRecords.id, params.data.id), eq(payrollRecords.employeeId, employee.id)))
        .limit(1);
    }
    if (!record) return reply.code(404).send({ error: 'Payroll record not found.' });
    return { payroll: (await shapeRecords([record]))[0] };
  });

  app.post('/runs', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const parsed = runSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a valid pay period and employee payroll figures.' });
    const { payPeriod, records } = parsed.data;
    if (new Set(records.map(record => record.employeeId)).size !== records.length) {
      return reply.code(400).send({ error: 'Each employee can appear only once in a payroll run.' });
    }
    const employeeIds = records.map(record => record.employeeId);
    const matched = await db.select({ id: employees.id, status: employees.status })
      .from(employees)
      .where(eq(employees.status, 'Active'));
    const activeIds = new Set(matched.map(employee => employee.id));
    if (employeeIds.some(id => !activeIds.has(id))) {
      return reply.code(400).send({ error: 'Payroll may only include active employee records.' });
    }

    const cents = (value: number) => Math.round(value * 100);
    for (const record of records) {
      const earnings = cents(record.basicSalary) + cents(record.hra) + cents(record.specialAllowance) + cents(record.bonus);
      const deductions = cents(record.providentFund) + cents(record.professionalTax) + cents(record.incomeTax);
      if (deductions > earnings) {
        return reply.code(400).send({ error: 'Deductions cannot exceed total earnings.' });
      }
    }

    const payPeriodDate = `${payPeriod}-01`;
    try {
      const created = await db.transaction(async tx => {
        const [run] = await tx.insert(payrollRuns).values({
          payPeriod: payPeriodDate,
          createdByUserId: user.id,
        }).returning();
        return tx.insert(payrollRecords).values(records.map(record => {
          const totalEarnings = (cents(record.basicSalary) + cents(record.hra) + cents(record.specialAllowance) + cents(record.bonus)) / 100;
          const totalDeductions = (cents(record.providentFund) + cents(record.professionalTax) + cents(record.incomeTax)) / 100;
          return {
            runId: run.id,
            employeeId: record.employeeId,
            basicSalary: record.basicSalary,
            hra: record.hra,
            specialAllowance: record.specialAllowance,
            bonus: record.bonus,
            providentFund: record.providentFund,
            professionalTax: record.professionalTax,
            incomeTax: record.incomeTax,
            totalEarnings,
            totalDeductions,
            netPay: totalEarnings - totalDeductions,
            status: 'Pending' as const,
          };
        })).returning();
      });
      return reply.code(201).send({ payroll: await shapeRecords(created) });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'A payroll run already exists for this pay period.' });
      }
      throw error;
    }
  });

  app.patch('/:id/status', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = statusSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'Invalid payroll record ID.' });
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a valid payroll status.' });
    const [record] = await db.update(payrollRecords).set({
      status: parsed.data.status,
      paymentDate: parsed.data.status === 'Paid' ? new Date().toISOString().slice(0, 10) : null,
      updatedAt: new Date(),
    }).where(eq(payrollRecords.id, params.data.id)).returning();
    if (!record) return reply.code(404).send({ error: 'Payroll record not found.' });
    return { payroll: (await shapeRecords([record]))[0] };
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23505';
}
