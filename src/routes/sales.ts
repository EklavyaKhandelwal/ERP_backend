import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { db } from '../db/index.js';
import {
  employees,
  salesAccounts,
  salesActivities,
  salesContacts,
  salesLeads,
  salesNotes,
  salesOpportunities,
  salesTechnologies,
  users,
} from '../db/schema.js';

const accountInput = z.object({
  companyName: z.string().trim().min(1).max(200),
  industry: z.string().trim().max(120).default(''),
  website: z.string().trim().max(500).default(''),
  linkedinUrl: z.string().trim().max(500).default(''),
  location: z.string().trim().max(200).default(''),
  ownerEmployeeId: z.string().uuid().optional(),
  status: z.enum(['Prospect', 'Active']).default('Prospect'),
}).strict();
const contactInput = z.object({
  name: z.string().trim().min(1).max(150),
  designation: z.string().trim().max(150).default(''),
  email: z.string().trim().email().max(254).or(z.literal('')).default(''),
  phone: z.string().trim().max(50).default(''),
  linkedinUrl: z.string().trim().max(500).default(''),
  status: z.enum(['Active', 'Inactive']).default('Active'),
}).strict();
const activityInput = z.object({
  contactId: z.string().uuid().nullable().default(null),
  type: z.enum(['Call', 'Email', 'Meeting', 'LinkedIn outreach', 'Follow-up']),
  activityDate: z.string().date(),
  remarks: z.string().trim().min(1).max(5000),
  nextFollowUpDate: z.string().date().nullable().default(null),
}).strict();
const leadInput = z.object({
  contactId: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(200),
  serviceInterest: z.string().trim().min(1).max(300),
  source: z.string().trim().min(1).max(120),
  status: z.enum(['New', 'Contacted', 'Qualified', 'Disqualified', 'Converted']).default('New'),
  assignedEmployeeId: z.string().uuid().optional(),
}).strict();
const opportunityInput = z.object({
  contactId: z.string().uuid().nullable().default(null),
  name: z.string().trim().min(1).max(200),
  serviceRequired: z.string().trim().min(1).max(300),
  stage: z.enum(['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Won', 'Lost']).default('Prospecting'),
  expectedClosingDate: z.string().date().nullable().default(null),
  notes: z.string().trim().max(5000).default(''),
}).strict();
const noteInput = z.object({ content: z.string().trim().min(1).max(5000) }).strict();
const technologyInput = z.object({ name: z.string().trim().min(1).max(100) }).strict();

type SalesUser = PublicUser & { employeeId: string | null };

async function getSalesUser(request: FastifyRequest, reply: FastifyReply): Promise<SalesUser | null> {
  const user = await authenticate(request);
  if (!user) {
    await reply.code(401).send({ error: 'Authentication required.' });
    return null;
  }
  if (user.role === 'admin') return { ...user, employeeId: null };
  if (!user.salesAccess) {
    await reply.code(403).send({ error: 'Sales module access is not enabled for your account.' });
    return null;
  }
  const [employee] = await db.select({ id: employees.id }).from(employees)
    .where(eq(employees.userId, user.id)).limit(1);
  if (!employee) {
    await reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });
    return null;
  }
  return { ...user, employeeId: employee.id };
}

async function getAccount(request: FastifyRequest, reply: FastifyReply, user: SalesUser) {
  const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
  if (!params.success) {
    await reply.code(400).send({ error: 'Invalid sales account ID.' });
    return null;
  }
  const where = user.employeeId
    ? and(eq(salesAccounts.id, params.data.id), eq(salesAccounts.ownerEmployeeId, user.employeeId))
    : eq(salesAccounts.id, params.data.id);
  const [account] = await db.select().from(salesAccounts).where(where).limit(1);
  if (!account) {
    await reply.code(404).send({ error: 'Sales account not found.' });
    return null;
  }
  return account;
}

async function validateContact(accountId: string, contactId: string | null): Promise<boolean> {
  if (!contactId) return true;
  const [contact] = await db.select({ id: salesContacts.id }).from(salesContacts)
    .where(and(eq(salesContacts.id, contactId), eq(salesContacts.accountId, accountId))).limit(1);
  return Boolean(contact);
}

async function isActiveSalesEmployee(employeeId: string): Promise<boolean> {
  const [employee] = await db.select({ id: employees.id }).from(employees)
    .innerJoin(users, eq(employees.userId, users.id))
    .where(and(
      eq(employees.id, employeeId),
      eq(employees.status, 'Active'),
      eq(users.role, 'employee'),
      eq(users.isActive, true),
      eq(users.salesAccess, true),
    )).limit(1);
  return Boolean(employee);
}

async function touchAccount(accountId: string): Promise<void> {
  await db.update(salesAccounts).set({ updatedAt: new Date() }).where(eq(salesAccounts.id, accountId));
}

export async function registerSalesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/access', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getSalesUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const records = await db.select({
      employeeId: employees.id,
      name: sql<string>`concat(${employees.firstName}, ' ', ${employees.lastName})`,
      email: employees.email,
      department: employees.department,
      isActive: users.isActive,
      salesAccess: users.salesAccess,
    }).from(employees)
      .innerJoin(users, eq(employees.userId, users.id))
      .where(and(eq(users.role, 'employee'), eq(users.isActive, true), eq(employees.status, 'Active')))
      .orderBy(asc(employees.lastName), asc(employees.firstName));
    return { employees: records };
  });

  app.patch('/access/:employeeId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getSalesUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const params = z.object({ employeeId: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ salesAccess: z.boolean() }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Provide a valid employee and Sales access setting.' });
    const [employee] = await db.select({ userId: employees.userId }).from(employees)
      .where(eq(employees.id, params.data.employeeId)).limit(1);
    if (!employee?.userId) return reply.code(404).send({ error: 'A linked employee account was not found.' });
    await db.update(users).set({ salesAccess: body.data.salesAccess, updatedAt: new Date() })
      .where(and(eq(users.id, employee.userId), eq(users.role, 'employee')));
    return { salesAccess: body.data.salesAccess };
  });

  app.get('/accounts', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getSalesUser(request, reply);
    if (!user) return reply;
    const query = z.object({
      search: z.string().trim().max(200).default(''),
      status: z.enum(['Prospect', 'Active']).optional(),
      ownerEmployeeId: z.string().uuid().optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid account search filters.' });
    if (user.employeeId && query.data.ownerEmployeeId) {
      return reply.code(403).send({ error: 'Only HR can filter accounts by owner.' });
    }
    const filters = [
      ...(user.employeeId ? [eq(salesAccounts.ownerEmployeeId, user.employeeId)] : []),
      ...(query.data.status ? [eq(salesAccounts.status, query.data.status)] : []),
      ...(query.data.ownerEmployeeId ? [eq(salesAccounts.ownerEmployeeId, query.data.ownerEmployeeId)] : []),
      ...(query.data.search ? [or(
        ilike(salesAccounts.companyName, `%${query.data.search}%`),
        ilike(salesAccounts.industry, `%${query.data.search}%`),
        ilike(salesAccounts.location, `%${query.data.search}%`),
      )!] : []),
    ];
    const accounts = await db.select({
      account: salesAccounts,
      ownerFirstName: employees.firstName,
      ownerLastName: employees.lastName,
    }).from(salesAccounts)
      .innerJoin(employees, eq(salesAccounts.ownerEmployeeId, employees.id))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(salesAccounts.companyName));
    const allCounts = await db.select({
      status: salesAccounts.status,
      count: sql<number>`count(*)::int`,
    }).from(salesAccounts)
      .where(user.employeeId ? eq(salesAccounts.ownerEmployeeId, user.employeeId) : undefined)
      .groupBy(salesAccounts.status);
    const visibilityFilter = user.employeeId ? eq(salesAccounts.ownerEmployeeId, user.employeeId) : undefined;
    const [recentAccounts, followUpRows] = await Promise.all([
      db.select({
        account: salesAccounts,
        ownerFirstName: employees.firstName,
        ownerLastName: employees.lastName,
      }).from(salesAccounts)
        .innerJoin(employees, eq(salesAccounts.ownerEmployeeId, employees.id))
        .where(visibilityFilter)
        .orderBy(sql`${salesAccounts.updatedAt} desc`)
        .limit(5),
      db.select({
        activity: salesActivities,
        account: salesAccounts,
        contactName: salesContacts.name,
        ownerFirstName: employees.firstName,
        ownerLastName: employees.lastName,
      }).from(salesActivities)
        .innerJoin(salesAccounts, eq(salesActivities.accountId, salesAccounts.id))
        .innerJoin(employees, eq(salesAccounts.ownerEmployeeId, employees.id))
        .leftJoin(salesContacts, eq(salesActivities.contactId, salesContacts.id))
        .where(and(
          visibilityFilter,
          lte(salesActivities.nextFollowUpDate, new Date().toISOString().slice(0, 10)),
        ))
        .orderBy(asc(salesActivities.nextFollowUpDate), asc(salesActivities.activityDate))
        .limit(8),
    ]);
    return {
      accounts: accounts.map(({ account, ownerFirstName, ownerLastName }) => ({
        ...account,
        ownerName: `${ownerFirstName} ${ownerLastName}`,
      })),
      counts: {
        total: allCounts.reduce((sum, item) => sum + item.count, 0),
        prospect: allCounts.find(item => item.status === 'Prospect')?.count ?? 0,
        active: allCounts.find(item => item.status === 'Active')?.count ?? 0,
      },
      recentAccounts: recentAccounts.map(({ account, ownerFirstName, ownerLastName }) => ({
        ...account,
        ownerName: `${ownerFirstName} ${ownerLastName}`,
      })),
      followUps: followUpRows.map(({ activity, account, contactName, ownerFirstName, ownerLastName }) => ({
        id: activity.id,
        accountId: account.id,
        companyName: account.companyName,
        ownerEmployeeId: account.ownerEmployeeId,
        ownerName: `${ownerFirstName} ${ownerLastName}`,
        contactId: activity.contactId,
        contactName,
        type: activity.type,
        remarks: activity.remarks,
        activityDate: activity.activityDate,
        nextFollowUpDate: activity.nextFollowUpDate,
      })),
    };
  });

  app.get('/contacts', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getSalesUser(request, reply);
    if (!user) return reply;
    const query = z.object({
      search: z.string().trim().max(200).default(''),
      status: z.enum(['Active', 'Inactive']).optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid contact search filters.' });
    const filters = [
      ...(user.employeeId ? [eq(salesAccounts.ownerEmployeeId, user.employeeId)] : []),
      ...(query.data.status ? [eq(salesContacts.status, query.data.status)] : []),
      ...(query.data.search ? [or(
        ilike(salesContacts.name, `%${query.data.search}%`),
        ilike(salesContacts.email, `%${query.data.search}%`),
        ilike(salesContacts.phone, `%${query.data.search}%`),
        ilike(salesAccounts.companyName, `%${query.data.search}%`),
      )!] : []),
    ];
    const rows = await db.select({
      contact: salesContacts,
      accountName: salesAccounts.companyName,
    }).from(salesContacts)
      .innerJoin(salesAccounts, eq(salesContacts.accountId, salesAccounts.id))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(salesAccounts.companyName), asc(salesContacts.name));
    const contactIds = rows.map(({ contact }) => contact.id);
    const activities = contactIds.length
      ? await db.select({
        contactId: salesActivities.contactId,
        activityDate: salesActivities.activityDate,
        type: salesActivities.type,
        remarks: salesActivities.remarks,
      }).from(salesActivities)
        .where(inArray(salesActivities.contactId, contactIds))
        .orderBy(sql`${salesActivities.activityDate} desc`, sql`${salesActivities.createdAt} desc`)
      : [];
    const latestActivityByContact = new Map<string, typeof activities[number]>();
    for (const activity of activities) {
      if (activity.contactId && !latestActivityByContact.has(activity.contactId)) {
        latestActivityByContact.set(activity.contactId, activity);
      }
    }
    return {
      contacts: rows.map(({ contact, accountName }) => {
        const latestActivity = latestActivityByContact.get(contact.id);
        return {
          ...contact,
          accountName,
          lastActivityDate: latestActivity?.activityDate ?? null,
          lastActivityType: latestActivity?.type ?? null,
          lastActivityRemarks: latestActivity?.remarks ?? null,
        };
      }),
    };
  });

  app.get('/updates', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getSalesUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const query = z.object({
      ownerEmployeeId: z.string().uuid().optional(),
      accountId: z.string().uuid().optional(),
      type: activityInput.shape.type.optional(),
      fromDate: z.string().date().optional(),
      toDate: z.string().date().optional(),
    }).safeParse(request.query);
    if (!query.success || (query.data.fromDate && query.data.toDate && query.data.fromDate > query.data.toDate)) {
      return reply.code(400).send({ error: 'Provide valid Sales Updates filters and date range.' });
    }
    const filters = [
      ...(query.data.ownerEmployeeId ? [eq(salesAccounts.ownerEmployeeId, query.data.ownerEmployeeId)] : []),
      ...(query.data.accountId ? [eq(salesAccounts.id, query.data.accountId)] : []),
      ...(query.data.type ? [eq(salesActivities.type, query.data.type)] : []),
      ...(query.data.fromDate ? [gte(salesActivities.activityDate, query.data.fromDate)] : []),
      ...(query.data.toDate ? [lte(salesActivities.activityDate, query.data.toDate)] : []),
    ];
    const rows = await db.select({
      activity: salesActivities,
      accountName: salesAccounts.companyName,
      ownerEmployeeId: salesAccounts.ownerEmployeeId,
      ownerFirstName: employees.firstName,
      ownerLastName: employees.lastName,
      contactName: salesContacts.name,
      loggedByName: users.name,
    }).from(salesActivities)
      .innerJoin(salesAccounts, eq(salesActivities.accountId, salesAccounts.id))
      .innerJoin(employees, eq(salesAccounts.ownerEmployeeId, employees.id))
      .innerJoin(users, eq(salesActivities.createdByUserId, users.id))
      .leftJoin(salesContacts, eq(salesActivities.contactId, salesContacts.id))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(salesActivities.activityDate), desc(salesActivities.createdAt))
      .limit(100);
    return {
      updates: rows.map(({ activity, accountName, ownerEmployeeId, ownerFirstName, ownerLastName, contactName, loggedByName }) => ({
        ...activity,
        accountName,
        ownerEmployeeId,
        ownerName: `${ownerFirstName} ${ownerLastName}`,
        contactName,
        loggedByName,
      })),
    };
  });

  app.post('/accounts', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getSalesUser(request, reply);
    if (!user) return reply;
    const parsed = accountInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Check the account details and try again.' });
    const ownerEmployeeId = user.employeeId ?? parsed.data.ownerEmployeeId;
    if (!ownerEmployeeId) return reply.code(400).send({ error: 'Choose an account owner.' });
    if (user.employeeId && parsed.data.ownerEmployeeId && parsed.data.ownerEmployeeId !== user.employeeId) {
      return reply.code(403).send({ error: 'You can only assign accounts to yourself.' });
    }
    if (!(await isActiveSalesEmployee(ownerEmployeeId))) {
      return reply.code(400).send({ error: 'Choose an active employee with Sales access as the account owner.' });
    }
    const [duplicate] = await db.select({ id: salesAccounts.id }).from(salesAccounts)
      .where(sql`lower(${salesAccounts.companyName}) = lower(${parsed.data.companyName})`).limit(1);
    if (duplicate) return reply.code(409).send({ error: 'An account with this company name already exists.' });
    const [account] = await db.insert(salesAccounts).values({
      ...parsed.data,
      ownerEmployeeId,
      createdByUserId: user.id,
    }).returning();
    return reply.code(201).send({ account });
  });

  app.get('/accounts/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getSalesUser(request, reply);
    if (!user) return reply;
    const account = await getAccount(request, reply, user);
    if (!account) return reply;
    const [owner, technologies, contacts, activities, leads, opportunities, notes] = await Promise.all([
      db.select({ firstName: employees.firstName, lastName: employees.lastName }).from(employees)
        .where(eq(employees.id, account.ownerEmployeeId)).limit(1),
      db.select().from(salesTechnologies).where(eq(salesTechnologies.accountId, account.id)).orderBy(asc(salesTechnologies.name)),
      db.select().from(salesContacts).where(eq(salesContacts.accountId, account.id)).orderBy(asc(salesContacts.name)),
      db.select().from(salesActivities).where(eq(salesActivities.accountId, account.id)).orderBy(asc(salesActivities.activityDate)),
      db.select().from(salesLeads).where(eq(salesLeads.accountId, account.id)).orderBy(asc(salesLeads.name)),
      db.select().from(salesOpportunities).where(eq(salesOpportunities.accountId, account.id)).orderBy(asc(salesOpportunities.name)),
      db.select().from(salesNotes).where(eq(salesNotes.accountId, account.id)).orderBy(asc(salesNotes.createdAt)),
    ]);
    return {
      account: { ...account, ownerName: owner[0] ? `${owner[0].firstName} ${owner[0].lastName}` : 'Unknown' },
      technologies,
      contacts,
      activities,
      leads,
      opportunities,
      notes,
    };
  });

  app.patch('/accounts/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getSalesUser(request, reply);
    if (!user) return reply;
    const account = await getAccount(request, reply, user);
    if (!account) return reply;
    const parsed = accountInput.partial().safeParse(request.body);
    if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
      return reply.code(400).send({ error: 'Provide valid account fields to update.' });
    }
    if (user.employeeId && parsed.data.ownerEmployeeId && parsed.data.ownerEmployeeId !== user.employeeId) {
      return reply.code(403).send({ error: 'You can only assign accounts to yourself.' });
    }
    if (parsed.data.ownerEmployeeId && !(await isActiveSalesEmployee(parsed.data.ownerEmployeeId))) {
      return reply.code(400).send({ error: 'Choose an active employee with Sales access as the account owner.' });
    }
    const [duplicate] = parsed.data.companyName
      ? await db.select({ id: salesAccounts.id }).from(salesAccounts)
        .where(and(
          sql`lower(${salesAccounts.companyName}) = lower(${parsed.data.companyName})`,
          sql`${salesAccounts.id} <> ${account.id}`,
        )).limit(1)
      : [];
    if (duplicate) return reply.code(409).send({ error: 'An account with this company name already exists.' });
    const [updated] = await db.update(salesAccounts)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(salesAccounts.id, account.id)).returning();
    return { account: updated };
  });

  app.post('/accounts/:id/technologies', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getSalesUser(request, reply);
    if (!user) return reply;
    const account = await getAccount(request, reply, user);
    if (!account) return reply;
    const parsed = technologyInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter a technology name.' });
    const [existing] = await db.select({ id: salesTechnologies.id }).from(salesTechnologies)
      .where(and(eq(salesTechnologies.accountId, account.id), sql`lower(${salesTechnologies.name}) = lower(${parsed.data.name})`)).limit(1);
    if (existing) return reply.code(409).send({ error: 'This technology is already listed for the account.' });
    const [technology] = await db.insert(salesTechnologies).values({ accountId: account.id, name: parsed.data.name }).returning();
    await touchAccount(account.id);
    return reply.code(201).send({ technology });
  });

  app.delete('/accounts/:id/technologies/:technologyId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getSalesUser(request, reply);
    if (!user) return reply;
    const account = await getAccount(request, reply, user);
    if (!account) return reply;
    const params = z.object({ technologyId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid technology ID.' });
    const deleted = await db.delete(salesTechnologies).where(and(
      eq(salesTechnologies.id, params.data.technologyId),
      eq(salesTechnologies.accountId, account.id),
    )).returning({ id: salesTechnologies.id });
    if (!deleted.length) return reply.code(404).send({ error: 'Technology not found.' });
    await touchAccount(account.id);
    return reply.code(204).send();
  });

  app.post('/accounts/:id/records/:kind', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getSalesUser(request, reply);
    if (!user) return reply;
    const account = await getAccount(request, reply, user);
    if (!account) return reply;
    const params = z.object({ kind: z.enum(['contacts', 'activities', 'leads', 'opportunities', 'notes']) }).safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'Unknown sales record type.' });
    const kind = params.data.kind;
    if (kind === 'contacts') {
      const parsed = contactInput.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Check the contact details and try again.' });
      const [record] = await db.insert(salesContacts).values({ ...parsed.data, accountId: account.id }).returning();
      await touchAccount(account.id);
      return reply.code(201).send({ record });
    }
    if (kind === 'activities') {
      const parsed = activityInput.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Check the activity details and try again.' });
      if (!(await validateContact(account.id, parsed.data.contactId))) return reply.code(400).send({ error: 'Choose a contact from this account.' });
      const [record] = await db.insert(salesActivities).values({ ...parsed.data, accountId: account.id, createdByUserId: user.id }).returning();
      await touchAccount(account.id);
      return reply.code(201).send({ record });
    }
    if (kind === 'leads') {
      const parsed = leadInput.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Check the lead details and try again.' });
      if (!(await validateContact(account.id, parsed.data.contactId))) return reply.code(400).send({ error: 'Choose a contact from this account.' });
      const assignedEmployeeId = user.employeeId ?? parsed.data.assignedEmployeeId;
      if (!assignedEmployeeId) return reply.code(400).send({ error: 'Choose an assigned employee.' });
      if (user.employeeId && parsed.data.assignedEmployeeId && parsed.data.assignedEmployeeId !== user.employeeId) {
        return reply.code(403).send({ error: 'You can only assign leads to yourself.' });
      }
      if (!(await isActiveSalesEmployee(assignedEmployeeId))) return reply.code(400).send({ error: 'Choose an active employee with Sales access.' });
      const [record] = await db.insert(salesLeads).values({ ...parsed.data, accountId: account.id, assignedEmployeeId }).returning();
      await touchAccount(account.id);
      return reply.code(201).send({ record });
    }
    if (kind === 'opportunities') {
      const parsed = opportunityInput.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'Check the opportunity details and try again.' });
      if (!(await validateContact(account.id, parsed.data.contactId))) return reply.code(400).send({ error: 'Choose a contact from this account.' });
      const [record] = await db.insert(salesOpportunities).values({ ...parsed.data, accountId: account.id }).returning();
      await touchAccount(account.id);
      return reply.code(201).send({ record });
    }
    const parsed = noteInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter a note.' });
    const [record] = await db.insert(salesNotes).values({
      accountId: account.id,
      content: parsed.data.content,
      createdByUserId: user.id,
    }).returning();
    await touchAccount(account.id);
    return reply.code(201).send({ record });
  });

  app.patch('/accounts/:id/records/:kind/:recordId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getSalesUser(request, reply);
    if (!user) return reply;
    const account = await getAccount(request, reply, user);
    if (!account) return reply;
    const params = z.object({
      kind: z.enum(['contacts', 'activities', 'leads', 'opportunities', 'notes']),
      recordId: z.string().uuid(),
    }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid sales record.' });
    const { kind, recordId } = params.data;
    if (kind === 'contacts') {
      const parsed = contactInput.partial().strict().safeParse(request.body);
      if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return reply.code(400).send({ error: 'Provide valid contact fields.' });
      const [record] = await db.update(salesContacts).set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(salesContacts.id, recordId), eq(salesContacts.accountId, account.id))).returning();
      if (!record) return reply.code(404).send({ error: 'Contact not found.' });
      await touchAccount(account.id);
      return { record };
    }
    if (kind === 'activities') {
      const parsed = activityInput.partial().strict().safeParse(request.body);
      if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return reply.code(400).send({ error: 'Provide valid activity fields.' });
      if (parsed.data.contactId !== undefined && !(await validateContact(account.id, parsed.data.contactId))) return reply.code(400).send({ error: 'Choose a contact from this account.' });
      const [record] = await db.update(salesActivities).set(parsed.data)
        .where(and(eq(salesActivities.id, recordId), eq(salesActivities.accountId, account.id))).returning();
      if (!record) return reply.code(404).send({ error: 'Activity not found.' });
      await touchAccount(account.id);
      return { record };
    }
    if (kind === 'leads') {
      const parsed = leadInput.partial().strict().safeParse(request.body);
      if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return reply.code(400).send({ error: 'Provide valid lead fields.' });
      if (parsed.data.contactId !== undefined && !(await validateContact(account.id, parsed.data.contactId))) return reply.code(400).send({ error: 'Choose a contact from this account.' });
      if (user.employeeId && parsed.data.assignedEmployeeId && parsed.data.assignedEmployeeId !== user.employeeId) return reply.code(403).send({ error: 'You can only assign leads to yourself.' });
      if (parsed.data.assignedEmployeeId && !(await isActiveSalesEmployee(parsed.data.assignedEmployeeId))) return reply.code(400).send({ error: 'Choose an active employee with Sales access.' });
      const [record] = await db.update(salesLeads).set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(salesLeads.id, recordId), eq(salesLeads.accountId, account.id))).returning();
      if (!record) return reply.code(404).send({ error: 'Lead not found.' });
      await touchAccount(account.id);
      return { record };
    }
    if (kind === 'opportunities') {
      const parsed = opportunityInput.partial().strict().safeParse(request.body);
      if (!parsed.success || !Object.keys(parsed.data ?? {}).length) return reply.code(400).send({ error: 'Provide valid opportunity fields.' });
      if (parsed.data.contactId !== undefined && !(await validateContact(account.id, parsed.data.contactId))) return reply.code(400).send({ error: 'Choose a contact from this account.' });
      const [record] = await db.update(salesOpportunities).set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(salesOpportunities.id, recordId), eq(salesOpportunities.accountId, account.id))).returning();
      if (!record) return reply.code(404).send({ error: 'Opportunity not found.' });
      await touchAccount(account.id);
      return { record };
    }
    const parsed = noteInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Enter a note.' });
    const [record] = await db.update(salesNotes).set({ content: parsed.data.content, updatedAt: new Date() })
      .where(and(eq(salesNotes.id, recordId), eq(salesNotes.accountId, account.id))).returning();
    if (!record) return reply.code(404).send({ error: 'Note not found.' });
    await touchAccount(account.id);
    return { record };
  });

  app.delete('/accounts/:id/records/:kind/:recordId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getSalesUser(request, reply);
    if (!user) return reply;
    const account = await getAccount(request, reply, user);
    if (!account) return reply;
    const params = z.object({
      kind: z.enum(['contacts', 'activities', 'leads', 'opportunities', 'notes']),
      recordId: z.string().uuid(),
    }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid sales record.' });
    const { kind, recordId } = params.data;
    const deleted = kind === 'contacts'
      ? await db.delete(salesContacts).where(and(eq(salesContacts.id, recordId), eq(salesContacts.accountId, account.id))).returning({ id: salesContacts.id })
      : kind === 'activities'
      ? await db.delete(salesActivities).where(and(eq(salesActivities.id, recordId), eq(salesActivities.accountId, account.id))).returning({ id: salesActivities.id })
      : kind === 'leads'
      ? await db.delete(salesLeads).where(and(eq(salesLeads.id, recordId), eq(salesLeads.accountId, account.id))).returning({ id: salesLeads.id })
      : kind === 'opportunities'
      ? await db.delete(salesOpportunities).where(and(eq(salesOpportunities.id, recordId), eq(salesOpportunities.accountId, account.id))).returning({ id: salesOpportunities.id })
      : await db.delete(salesNotes).where(and(eq(salesNotes.id, recordId), eq(salesNotes.accountId, account.id))).returning({ id: salesNotes.id });
    if (!deleted.length) return reply.code(404).send({ error: 'Sales record not found.' });
    await touchAccount(account.id);
    return reply.code(204).send();
  });
}
