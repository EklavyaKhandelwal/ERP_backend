import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './index.js';
import { employeeLeaveBalances, employees, leavePolicies, users } from './schema.js';

const seedSchema = z.object({
  SEED_USER_EMAIL: z.string().email(),
  SEED_USER_PASSWORD: z.string().min(12).max(128).refine(
    password => Buffer.byteLength(password, 'utf8') <= 72,
    'Seed password must be no more than 72 UTF-8 bytes.',
  ),
  SEED_USER_NAME: z.string().min(1),
  SEED_USER_ROLE: z.enum(['admin', 'employee']).default('admin'),
  SEED_USER_DEPARTMENT: z.string().default('Unassigned'),
  SEED_USER_DESIGNATION: z.string().default('Team member'),
});

const config = seedSchema.parse(process.env);
const email = config.SEED_USER_EMAIL.toLowerCase();
const [existingOwner] = await db.select({ id: users.id }).from(users).where(eq(users.isOwner, true)).limit(1);
let user = await db.query.users.findFirst({
  where: eq(users.email, email),
  columns: { id: true, name: true, role: true },
});

if (user && user.role !== config.SEED_USER_ROLE) {
  throw new Error(`The existing account for ${email} has a different role; seed will not change it.`);
}

if (!user) {
  const passwordHash = await bcrypt.hash(config.SEED_USER_PASSWORD, 12);
  [user] = await db.insert(users).values({
    email,
    passwordHash,
    name: config.SEED_USER_NAME,
    role: config.SEED_USER_ROLE,
    isOwner: config.SEED_USER_ROLE === 'admin' && !existingOwner,
    department: config.SEED_USER_DEPARTMENT,
    designation: config.SEED_USER_DESIGNATION,
  }).returning({ id: users.id, name: users.name, role: users.role });
} else if (config.SEED_USER_ROLE === 'admin' && !existingOwner) {
  await db.update(users).set({ isOwner: true, updatedAt: new Date() }).where(eq(users.id, user.id));
}

const linkedEmployee = await db.query.employees.findFirst({
  where: eq(employees.userId, user.id),
  columns: { id: true },
});

if (!linkedEmployee) {
  const existingEmployee = await db.query.employees.findFirst({
    where: eq(employees.email, email),
    columns: { id: true },
  });
  if (existingEmployee) {
    throw new Error(`An employee record for ${email} already exists but is not linked to this account.`);
  }

  const [firstName, ...lastNameParts] = user.name.trim().split(/\s+/);
  const [policy] = await db.select().from(leavePolicies).where(eq(leavePolicies.id, 1)).limit(1);
  const annualDays = policy?.annualDays ?? 20;
  const sickDays = policy?.sickDays ?? 10;
  const casualDays = policy?.casualDays ?? 6;
  await db.transaction(async tx => {
    const [employee] = await tx.insert(employees).values({
      userId: user.id,
      firstName,
      lastName: lastNameParts.join(' ') || firstName,
      email,
      department: config.SEED_USER_DEPARTMENT,
      designation: config.SEED_USER_DESIGNATION,
      joinDate: new Date().toISOString().slice(0, 10),
      annualLeave: annualDays,
      annualLeaveTotal: annualDays,
      sickLeave: sickDays,
      sickLeaveTotal: sickDays,
      casualLeave: casualDays,
      casualLeaveTotal: casualDays,
    }).returning({ id: employees.id });
    await tx.insert(employeeLeaveBalances).values({
      employeeId: employee.id,
      year: new Date().getFullYear(),
      annualBalance: annualDays,
      annualTotal: annualDays,
      sickBalance: sickDays,
      sickTotal: sickDays,
      casualBalance: casualDays,
      casualTotal: casualDays,
    });
  });
}

console.info(`Account and employee profile are ready for ${email}.`);
