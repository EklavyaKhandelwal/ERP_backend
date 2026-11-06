import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { db } from '../db/index.js';
import { accountAccessTokens, employeeLeaveBalances, employees, leavePolicies, projectMembers, projects, sessions, users } from '../db/schema.js';

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
  bankName: z.string().trim().max(120).default(''),
  bankAccountNumber: z.string().trim().max(64).default(''),
  location: z.string().trim().max(150).default('Remote'),
  manager: z.string().trim().max(150).default(''),
  skills: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
});

type EmployeeRecord = typeof employees.$inferSelect;

function toEmployee(
  employee: EmployeeRecord,
  accountStatus: 'Not set up' | 'Invitation pending' | 'Active' | 'Deactivated' | 'Admin account',
  includeAccountStatus = true,
  leaveBalance?: typeof employeeLeaveBalances.$inferSelect,
) {
  return {
    id: employee.id,
    employeeCode: `EMP-${String(employee.employeeNumber).padStart(4, '0')}`,
    firstName: employee.firstName,
    lastName: employee.lastName,
    email: employee.email,
    phone: employee.phone,
    dateOfBirth: employee.dateOfBirth,
    avatar: employee.avatar,
    role: employee.role,
    department: employee.department,
    designation: employee.designation,
    joinDate: employee.joinDate,
    status: employee.status,
    salary: employee.salary,
    bankName: employee.bankName,
    bankAccountNumber: employee.bankAccountNumber,
    location: employee.location,
    manager: employee.manager,
    skills: employee.skills,
    leaveBalance: {
      year: leaveBalance?.year ?? new Date().getFullYear(),
      annual: leaveBalance?.annualBalance ?? employee.annualLeave,
      annualTotal: leaveBalance?.annualTotal ?? employee.annualLeaveTotal,
      sick: leaveBalance?.sickBalance ?? employee.sickLeave,
      sickTotal: leaveBalance?.sickTotal ?? employee.sickLeaveTotal,
      casual: leaveBalance?.casualBalance ?? employee.casualLeave,
      casualTotal: leaveBalance?.casualTotal ?? employee.casualLeaveTotal,
    },
    ...(includeAccountStatus ? { accountStatus } : {}),
  };
}

function employeeAvatar(employee: EmployeeRecord, accountAvatar?: string | null): string {
  return accountAvatar && accountAvatar !== '/favicon.svg' ? accountAvatar : employee.avatar;
}

function toDirectoryEmployee(employee: EmployeeRecord, avatar = employee.avatar) {
  return {
    id: employee.id,
    employeeCode: `EMP-${String(employee.employeeNumber).padStart(4, '0')}`,
    firstName: employee.firstName,
    lastName: employee.lastName,
    email: employee.email,
    avatar,
    role: employee.role,
    department: employee.department,
    designation: employee.designation,
    joinDate: employee.joinDate,
    status: employee.status,
    location: employee.location,
    manager: employee.manager,
    skills: employee.skills,
  };
}

async function toEmployees(records: EmployeeRecord[], includeAccountStatus = true) {
  if (!records.length) return [];
  const userIds = records.flatMap(employee => employee.userId ? [employee.userId] : []);
  const unlinkedEmployeeIds = records.filter(employee => !employee.userId).map(employee => employee.id);
  const employeeIds = records.map(employee => employee.id);
  const currentYear = new Date().getFullYear();
  const [linkedUsers, pendingTokens, existingBalances] = await Promise.all([
    userIds.length
      ? db.select({
        id: users.id,
        email: users.email,
        isActive: users.isActive,
        role: users.role,
        avatar: users.avatar,
      }).from(users).where(or(
        inArray(users.id, userIds),
        inArray(users.email, records.map(employee => employee.email.toLowerCase())),
      ))
      : db.select({
        id: users.id,
        email: users.email,
        isActive: users.isActive,
        role: users.role,
        avatar: users.avatar,
      }).from(users).where(inArray(users.email, records.map(employee => employee.email.toLowerCase()))),
    unlinkedEmployeeIds.length
      ? db.select({ employeeId: accountAccessTokens.employeeId }).from(accountAccessTokens)
        .where(and(
          inArray(accountAccessTokens.employeeId, unlinkedEmployeeIds),
          isNull(accountAccessTokens.consumedAt),
          gt(accountAccessTokens.expiresAt, new Date()),
        ))
      : Promise.resolve([]),
    db.select().from(employeeLeaveBalances)
      .where(and(
        inArray(employeeLeaveBalances.employeeId, employeeIds),
        eq(employeeLeaveBalances.year, currentYear),
      )),
  ]);
  const usersById = new Map(linkedUsers.map(user => [user.id, user]));
  const usersByEmail = new Map(linkedUsers.map(user => [user.email.toLowerCase(), user]));
  const pendingIds = new Set(pendingTokens.map(token => token.employeeId));

  const balancesByEmployee = new Map(existingBalances.map(balance => [balance.employeeId, balance]));

  return records.map(employee => {
    const linkedUser = employee.userId ? usersById.get(employee.userId) : undefined;
    const avatarUser = linkedUser ?? usersByEmail.get(employee.email.toLowerCase());
    const accountStatus = linkedUser?.role === 'admin'
      ? 'Admin account'
      : linkedUser
      ? linkedUser.isActive ? 'Active' : 'Deactivated'
      : pendingIds.has(employee.id) ? 'Invitation pending' : 'Not set up';
    return {
      ...toEmployee(employee, accountStatus, includeAccountStatus, balancesByEmployee.get(employee.id)),
      avatar: employeeAvatar(employee, avatarUser?.avatar),
    };
  });
}

async function getDirectoryAvatars(records: EmployeeRecord[]): Promise<Map<string, string>> {
  if (!records.length) return new Map();
  const userIds = records.flatMap(employee => employee.userId ? [employee.userId] : []);
  const accountUsers = await db.select({
    id: users.id,
    email: users.email,
    avatar: users.avatar,
  }).from(users).where(or(
    inArray(users.id, userIds),
    inArray(users.email, records.map(employee => employee.email.toLowerCase())),
  ));
  const usersById = new Map(accountUsers.map(user => [user.id, user]));
  const usersByEmail = new Map(accountUsers.map(user => [user.email.toLowerCase(), user]));
  return new Map(records.map(employee => {
    const accountUser = (employee.userId ? usersById.get(employee.userId) : undefined)
      ?? usersByEmail.get(employee.email.toLowerCase());
    return [employee.id, employeeAvatar(employee, accountUser?.avatar)];
  }));
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

    const allRecords = await db.select().from(employees).orderBy(asc(employees.lastName), asc(employees.firstName));
    const adminAccounts = await db.select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.role, 'admin'));
    const adminUserIds = new Set(adminAccounts.map(account => account.id));
    const adminEmails = new Set(adminAccounts.map(account => account.email.toLowerCase()));
    const records = allRecords.filter(record => (
      !(record.userId && adminUserIds.has(record.userId))
      && !adminEmails.has(record.email.toLowerCase())
    ));

    if (user.role === 'admin') {
      return { employees: await toEmployees(records) };
    }

    const ownRecords = records.filter(record => record.userId === user.id);
    const ownEmployees = await toEmployees(ownRecords, false);
    const ownEmployee = ownEmployees[0];
    const avatars = await getDirectoryAvatars(records);
    return {
      employees: records.map(record => (
        record.userId === user.id && ownEmployee
          ? ownEmployee
          : toDirectoryEmployee(record, avatars.get(record.id))
      )),
    };
  });

  app.get('/:id/projects', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;

    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid employee ID.' });

    const [employee] = await db.select({ id: employees.id }).from(employees)
      .where(eq(employees.id, params.data.id)).limit(1);
    if (!employee) return reply.code(404).send({ error: 'Employee not found.' });

    const assignedProjects = await db.select({
      id: projects.id,
      name: projects.name,
      code: projects.code,
      status: projects.status,
      progress: projects.progress,
      deadline: projects.deadline,
      role: projectMembers.role,
    })
      .from(projectMembers)
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(eq(projectMembers.employeeId, employee.id))
      .orderBy(asc(projects.deadline), asc(projects.name));

    return { projects: assignedProjects };
  });

  app.get('/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;

    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid employee ID.' });

    const [record] = await db.select().from(employees)
      .where(eq(employees.id, params.data.id))
      .limit(1);

    if (!record) return reply.code(404).send({ error: 'Employee not found.' });
    if (user.role === 'admin') {
      return { employee: (await toEmployees([record]))[0] };
    }
    if (record.userId === user.id) {
      return { employee: (await toEmployees([record], false))[0] };
    }
    const avatars = await getDirectoryAvatars([record]);
    return { employee: toDirectoryEmployee(record, avatars.get(record.id)) };
  });

  app.post('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!(await requireAdmin(request, reply))) return reply;

    const parsed = employeeInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Check the employee details and try again.' });
    }

    const data = parsed.data;
    const [leavePolicy] = await db.select().from(leavePolicies).where(eq(leavePolicies.id, 1)).limit(1);
    const [matchingUser] = await db.select({ id: users.id, role: users.role, avatar: users.avatar })
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
      const currentYear = new Date().getFullYear();
      const annualDays = leavePolicy?.annualDays ?? 20;
      const sickDays = leavePolicy?.sickDays ?? 10;
      const casualDays = leavePolicy?.casualDays ?? 6;
      const record = await db.transaction(async tx => {
        const [created] = await tx.insert(employees).values({
          ...data,
          email: data.email.toLowerCase(),
          userId: matchingUser?.id ?? null,
          avatar: data.avatar === '/favicon.svg' ? matchingUser?.avatar ?? data.avatar : data.avatar,
          annualLeave: annualDays,
          annualLeaveTotal: annualDays,
          sickLeave: sickDays,
          sickLeaveTotal: sickDays,
          casualLeave: casualDays,
          casualLeaveTotal: casualDays,
        }).returning();
        await tx.insert(employeeLeaveBalances).values({
          employeeId: created.id,
          year: currentYear,
          annualBalance: annualDays,
          annualTotal: annualDays,
          sickBalance: sickDays,
          sickTotal: sickDays,
          casualBalance: casualDays,
          casualTotal: casualDays,
        });
        return created;
      });
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
