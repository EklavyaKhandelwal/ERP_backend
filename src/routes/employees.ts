import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { db } from '../db/index.js';
import { accountAccessTokens, employees, sessions, users } from '../db/schema.js';

const employeeStatus = z.enum(['Active', 'On Leave', 'Probation', 'Inactive']);
const employeeInput = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(50).default(''),
  avatar: z.string().trim().max(2048).default('/favicon.svg'),
  role: z.string().trim().min(1).max(100).default('employee'),
  department: z.string().trim().min(1).max(100),
  designation: z.string().trim().min(1).max(150),
  joinDate: z.string().date(),
  status: employeeStatus.default('Active'),
  salary: z.number().finite().min(0).max(1_000_000_000).default(0),
  location: z.string().trim().max(150).default('Remote'),
  manager: z.string().trim().max(150).default(''),
  skills: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
});

type EmployeeRecord = typeof employees.$inferSelect;

function toEmployee(employee: EmployeeRecord, accountStatus: 'Not set up' | 'Invitation pending' | 'Active' | 'Deactivated' | 'Admin account') {
  return {
    id: employee.id,
    employeeCode: `EMP-${String(employee.employeeNumber).padStart(4, '0')}`,
    firstName: employee.firstName,
    lastName: employee.lastName,
    email: employee.email,
    phone: employee.phone,
    avatar: employee.avatar,
    role: employee.role,
    department: employee.department,
    designation: employee.designation,
    joinDate: employee.joinDate,
    status: employee.status,
    salary: employee.salary,
    location: employee.location,
    manager: employee.manager,
    skills: employee.skills,
    leaveBalance: {
      annual: employee.annualLeave,
      annualTotal: employee.annualLeaveTotal,
      sick: employee.sickLeave,
      sickTotal: employee.sickLeaveTotal,
      casual: employee.casualLeave,
      casualTotal: employee.casualLeaveTotal,
    },
    accountStatus,
  };
}

async function toEmployees(records: EmployeeRecord[]) {
  if (!records.length) return [];
  const userIds = records.flatMap(employee => employee.userId ? [employee.userId] : []);
  const linkedUsers = userIds.length
    ? await db.select({ id: users.id, isActive: users.isActive, role: users.role }).from(users).where(inArray(users.id, userIds))
    : [];
  const usersById = new Map(linkedUsers.map(user => [user.id, user]));
  const unlinkedEmployeeIds = records.filter(employee => !employee.userId).map(employee => employee.id);
  const pendingTokens = unlinkedEmployeeIds.length
    ? await db.select({ employeeId: accountAccessTokens.employeeId }).from(accountAccessTokens)
      .where(and(
        inArray(accountAccessTokens.employeeId, unlinkedEmployeeIds),
        isNull(accountAccessTokens.consumedAt),
        gt(accountAccessTokens.expiresAt, new Date()),
      ))
    : [];
  const pendingIds = new Set(pendingTokens.map(token => token.employeeId));

  return records.map(employee => {
    const linkedUser = employee.userId ? usersById.get(employee.userId) : undefined;
    const accountStatus = linkedUser?.role === 'admin'
      ? 'Admin account'
      : linkedUser
      ? linkedUser.isActive ? 'Active' : 'Deactivated'
      : pendingIds.has(employee.id) ? 'Invitation pending' : 'Not set up';
    return toEmployee(employee, accountStatus);
  });
}
async function getUser(request: FastifyRequest, reply: FastifyReply): Promise<PublicUser | null> {
  const user = await authenticate(request);
  if (!user) {
    await reply.code(401).send({ error: 'Authentication required.' });
    return null;
  }
  return user;
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<PublicUser | null> {
  const user = await getUser(request, reply);
  if (user && user.role !== 'admin') {
    await reply.code(403).send({ error: 'Administrator access required.' });
    return null;
  }
  return user;
}

export async function registerEmployeeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;

    const records = user.role === 'admin'
      ? await db.select().from(employees).orderBy(asc(employees.lastName), asc(employees.firstName))
      : await db.select().from(employees).where(eq(employees.userId, user.id));

    return { employees: await toEmployees(records) };
  });

  app.get('/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;

    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid employee ID.' });

    const [record] = await db.select().from(employees)
      .where(user.role === 'admin'
        ? eq(employees.id, params.data.id)
        : and(eq(employees.id, params.data.id), eq(employees.userId, user.id)))
      .limit(1);

    if (!record) return reply.code(404).send({ error: 'Employee not found.' });
    return { employee: (await toEmployees([record]))[0] };
  });

  app.post('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!(await requireAdmin(request, reply))) return reply;

    const parsed = employeeInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Check the employee details and try again.' });
    }

    const data = parsed.data;
    const [matchingUser] = await db.select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.email, data.email.toLowerCase()))
      .limit(1);
    if (matchingUser?.role === 'admin') {
      return reply.code(409).send({ error: 'This email belongs to an administrator account.' });
    }
    if (matchingUser) {
      const [existingProfile] = await db.select({ id: employees.id })
        .from(employees)
        .where(eq(employees.userId, matchingUser.id))
        .limit(1);
      if (existingProfile) {
        return reply.code(409).send({ error: 'This account already has an employee profile.' });
      }
    }

    try {
      const [record] = await db.insert(employees).values({
        ...data,
        email: data.email.toLowerCase(),
        userId: matchingUser?.id ?? null,
      }).returning();
      return reply.code(201).send({ employee: (await toEmployees([record]))[0] });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'An employee with this email already exists.' });
      }
      throw error;
    }
  });

  app.patch('/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!(await requireAdmin(request, reply))) return reply;

    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid employee ID.' });

    const parsed = employeeInput.partial().safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
      return reply.code(400).send({ error: 'Provide valid employee fields to update.' });
    }

    const data = parsed.data;
    const [existing] = await db.select({ userId: employees.userId, email: employees.email })
      .from(employees)
      .where(eq(employees.id, params.data.id))
      .limit(1);
    if (!existing) return reply.code(404).send({ error: 'Employee not found.' });
    if (data.email
      && data.email.toLowerCase() !== existing.email
      && existing.userId) {
      return reply.code(409).send({ error: 'Changing the email for a login-linked employee is not supported yet.' });
    }

    if (data.email) {
      const [matchingUser] = await db.select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.email, data.email.toLowerCase()))
        .limit(1);
      if (matchingUser?.role === 'admin') {
        return reply.code(409).send({ error: 'This email belongs to an administrator account.' });
      }
    }

    try {
      const record = await db.transaction(async tx => {
        const now = new Date();
        const [updated] = await tx.update(employees)
          .set({
            ...data,
            ...(data.email ? { email: data.email.toLowerCase() } : {}),
            updatedAt: now,
          })
          .where(eq(employees.id, params.data.id))
          .returning();
        if (!updated) return undefined;
        if (data.status === 'Inactive' && updated.userId) {
          await tx.update(users).set({ isActive: false, updatedAt: now })
            .where(and(eq(users.id, updated.userId), eq(users.role, 'employee')));
          await tx.delete(sessions).where(eq(sessions.userId, updated.userId));
        }
        if (data.email && data.email.toLowerCase() !== existing.email && !existing.userId) {
          await tx.update(accountAccessTokens).set({ consumedAt: now })
            .where(and(
              eq(accountAccessTokens.employeeId, updated.id),
              isNull(accountAccessTokens.consumedAt),
            ));
        }
        return updated;
      });
      if (!record) return reply.code(404).send({ error: 'Employee not found.' });
      return { employee: (await toEmployees([record]))[0] };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: 'An employee with this email already exists.' });
      }
      throw error;
    }
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23505';
}
