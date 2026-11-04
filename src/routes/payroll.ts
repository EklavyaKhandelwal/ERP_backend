import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { db } from '../db/index.js';
import { employees, notifications, payrollRecordRevisions, payrollRecords, payrollRuns } from '../db/schema.js';

const amount = z.number().finite().min(0).max(1_000_000_000).multipleOf(0.01);
const runSchema = z.object({
  payPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Pay period must use YYYY-MM format.'),
  records: z.array(z.object({
    employeeId: z.string().uuid(),
    basicSalaryMaster: amount.default(0),
    hraMaster: amount.default(0),
    specialAllowanceMaster: amount.default(0),
    bonusMaster: amount.default(0),
    basicSalary: amount,
    hra: amount.default(0),
    specialAllowance: amount.default(0),
    bonus: amount.default(0),
    providentFund: amount.default(0),
    professionalTax: amount.default(0),
    incomeTax: amount.default(0),
  })).min(1).max(500),
});
const recordUpdateSchema = z.object({
  basicSalaryMaster: amount,
  hraMaster: amount,
  specialAllowanceMaster: amount,
  bonusMaster: amount,
  basicSalary: amount,
  hra: amount,
  specialAllowance: amount,
  bonus: amount,
  providentFund: amount,
  professionalTax: amount,
  incomeTax: amount,
  effectiveWorkDays: z.number().int().min(0).max(31),
  lossOfPayDays: z.number().int().min(0).max(31),
  bankName: z.string().trim().max(120),
  bankAccountNumber: z.string().trim().max(64),
  panNumber: z.string().trim().max(20),
  providentFundNumber: z.string().trim().max(40),
  providentFundUan: z.string().trim().max(40),
  otherDetails: z.string().trim().max(500),
  correctionNote: z.string().trim().min(10).max(500).optional(),
}).strict();
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
  const runIds = [...new Set(records.map(record => record.runId))];
  const [employeeRecords, runRecords] = await Promise.all([
    db.select().from(employees).where(inArray(employees.id, employeeIds)),
    db.select().from(payrollRuns).where(inArray(payrollRuns.id, runIds)),
  ]);
  const employeesById = new Map(employeeRecords.map(employee => [employee.id, employee]));
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
      joiningDate: employee.joinDate,
      location: employee.location,
      month: new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleString('en', { month: 'long', timeZone: 'UTC' }),
      year,
      basicSalaryMaster: record.basicSalaryMaster,
      hraMaster: record.hraMaster,
      specialAllowanceMaster: record.specialAllowanceMaster,
      bonusMaster: record.bonusMaster,
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
      effectiveWorkDays: record.effectiveWorkDays,
      lossOfPayDays: record.lossOfPayDays,
      bankName: record.bankName,
      bankAccountNumber: record.bankAccountNumber,
      panNumber: record.panNumber,
      providentFundNumber: record.providentFundNumber,
      providentFundUan: record.providentFundUan,
      otherDetails: record.otherDetails,
      payslipStatus: record.payslipStatus,
      revision: record.revision,
      ...(record.publishedAt ? { publishedAt: record.publishedAt.toISOString() } : {}),
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
      records = await db.select().from(payrollRecords).where(and(
        eq(payrollRecords.employeeId, employee.id),
        eq(payrollRecords.payslipStatus, 'Published'),
      ))
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
        .where(and(
          eq(payrollRecords.id, params.data.id),
          eq(payrollRecords.employeeId, employee.id),
          eq(payrollRecords.payslipStatus, 'Published'),
        ))
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
    const matched = await db.select({
      id: employees.id,
      status: employees.status,
      bankName: employees.bankName,
      bankAccountNumber: employees.bankAccountNumber,
    })
      .from(employees)
      .where(and(
        eq(employees.status, 'Active'),
        inArray(employees.id, employeeIds),
      ));
    const activeIds = new Set(matched.map(employee => employee.id));
    if (employeeIds.some(id => !activeIds.has(id))) {
      return reply.code(400).send({ error: 'Payroll may only include active employee records.' });
    }
    const employeeById = new Map(matched.map(employee => [employee.id, employee]));

    const cents = (value: number) => Math.round(value * 100);
    for (const record of records) {
      const earnings = cents(record.basicSalary) + cents(record.hra) + cents(record.specialAllowance) + cents(record.bonus);
      const deductions = cents(record.providentFund) + cents(record.professionalTax) + cents(record.incomeTax);
      if (deductions > earnings) {
        return reply.code(400).send({ error: 'Deductions cannot exceed total earnings.' });
      }
    }

    const payPeriodDate = `${payPeriod}-01`;
    const [periodYear, periodMonth] = payPeriod.split('-').map(Number);
    const effectiveWorkDays = new Date(Date.UTC(periodYear, periodMonth, 0)).getUTCDate();
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
            bankName: employeeById.get(record.employeeId)!.bankName,
            bankAccountNumber: employeeById.get(record.employeeId)!.bankAccountNumber,
            basicSalaryMaster: record.basicSalaryMaster,
            hraMaster: record.hraMaster,
            specialAllowanceMaster: record.specialAllowanceMaster,
            bonusMaster: record.bonusMaster,
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
            effectiveWorkDays,
            status: 'Pending' as const,
          };
        })).returning();
      });
      return reply.code(201).send({ payroll: await shapeRecords(created) });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({
          error: 'Payroll for this month has already been created. Choose another month or review the existing payroll run.',
        });
      }
      throw error;
    }
  });

  app.patch('/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = recordUpdateSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'Invalid payroll record ID.' });
    if (!parsed.success) return reply.code(400).send({ error: 'Provide valid payslip amounts, work days, and employee payment details.' });
    const { correctionNote, ...updates } = parsed.data;
    const cents = (value: number) => Math.round(value * 100);
    const totalEarnings = (
      cents(updates.basicSalary) + cents(updates.hra) + cents(updates.specialAllowance) + cents(updates.bonus)
    ) / 100;
    const totalDeductions = (
      cents(updates.providentFund) + cents(updates.professionalTax) + cents(updates.incomeTax)
    ) / 100;
    if (totalDeductions > totalEarnings) {
      return reply.code(400).send({ error: 'Deductions cannot exceed actual earnings.' });
    }

    const updated = await db.transaction(async tx => {
      const [current] = await tx.select().from(payrollRecords)
        .where(eq(payrollRecords.id, params.data.id)).limit(1);
      if (!current) return null;
      const [run] = await tx.select({ payPeriod: payrollRuns.payPeriod }).from(payrollRuns)
        .where(eq(payrollRuns.id, current.runId)).limit(1);
      if (!run) throw new Error(`Payroll run for record ${current.id} was not found.`);
      const daysInPeriod = new Date(Date.UTC(
        Number(run.payPeriod.slice(0, 4)),
        Number(run.payPeriod.slice(5, 7)),
        0,
      )).getUTCDate();
      if (updates.effectiveWorkDays + updates.lossOfPayDays > daysInPeriod) {
        return { conflict: `Effective work days plus LOP cannot exceed the ${daysInPeriod}-day pay period.` } as const;
      }
      if (current.payslipStatus === 'Published' && !correctionNote) {
        return { conflict: 'Published payslips require a correction note before they can be revised.' } as const;
      }
      if (current.payslipStatus === 'Published') {
        await tx.insert(payrollRecordRevisions).values({
          payrollRecordId: current.id,
          revision: current.revision,
          changedByUserId: user.id,
          note: correctionNote!,
          snapshot: current,
        });
      }
      const [record] = await tx.update(payrollRecords).set({
        ...updates,
        totalEarnings,
        totalDeductions,
        netPay: totalEarnings - totalDeductions,
        revision: current.payslipStatus === 'Published' ? current.revision + 1 : current.revision,
        updatedAt: new Date(),
      }).where(eq(payrollRecords.id, current.id)).returning();
      if (current.payslipStatus === 'Published') {
        const [employee] = await tx.select({ userId: employees.userId }).from(employees)
          .where(eq(employees.id, current.employeeId)).limit(1);
        if (employee?.userId) {
          await tx.insert(notifications).values({
            userId: employee.userId,
            title: `A revised payslip for ${run.payPeriod.slice(0, 7)} is available in your Payroll section.`,
          });
        }
      }
      return { record } as const;
    });
    if (!updated) return reply.code(404).send({ error: 'Payroll record not found.' });
    if ('conflict' in updated) return reply.code(409).send({ error: updated.conflict });
    return { payroll: (await shapeRecords([updated.record]))[0] };
  });

  app.patch('/:id/publish', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid payroll record ID.' });
    const record = await db.transaction(async tx => {
      const [current] = await tx.select().from(payrollRecords)
        .where(and(
          eq(payrollRecords.id, params.data.id),
          eq(payrollRecords.payslipStatus, 'Draft'),
        )).limit(1);
      if (!current) return null;
      const [published] = await tx.update(payrollRecords).set({
        payslipStatus: 'Published',
        publishedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(payrollRecords.id, current.id),
        eq(payrollRecords.payslipStatus, 'Draft'),
      )).returning();
      if (!published) return null;
      const [employee] = await tx.select({ userId: employees.userId }).from(employees)
        .where(eq(employees.id, current.employeeId)).limit(1);
      const [run] = await tx.select({ payPeriod: payrollRuns.payPeriod }).from(payrollRuns)
        .where(eq(payrollRuns.id, current.runId)).limit(1);
      if (!employee || !run) throw new Error(`Payroll record ${current.id} is missing employee or pay-period data.`);
      if (employee.userId) {
        await tx.insert(notifications).values({
          userId: employee.userId,
          title: `Your payslip for ${run.payPeriod.slice(0, 7)} is published and ready to download.`,
        });
      }
      return published;
    });
    if (!record) return reply.code(409).send({ error: 'Payslip was not found or is already published.' });
    return { payroll: (await shapeRecords([record]))[0] };
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
    const [existing] = await db.select({ payslipStatus: payrollRecords.payslipStatus })
      .from(payrollRecords).where(eq(payrollRecords.id, params.data.id)).limit(1);
    if (!existing) return reply.code(404).send({ error: 'Payroll record not found.' });
    if (existing.payslipStatus !== 'Published') {
      return reply.code(409).send({ error: 'Publish the payslip before recording payment status.' });
    }
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
  const seen = new Set<object>();
  let current = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && current.code === '23505') return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}
