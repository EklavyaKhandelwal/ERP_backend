import { asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { db } from '../db/index.js';
import { employees, projectMembers, projects } from '../db/schema.js';

const projectStatus = z.enum(['Active', 'In Progress', 'Completed', 'On Hold']);
const projectInput = z.object({
  name: z.string().trim().min(1).max(150),
  client: z.string().trim().min(1).max(150),
  status: projectStatus.default('Active'),
  progress: z.number().int().min(0).max(100).default(0),
  budget: z.number().finite().min(0).max(1_000_000_000_000),
  spent: z.number().finite().min(0).max(1_000_000_000_000).default(0),
  startDate: z.string().date().optional(),
  deadline: z.string().date(),
  description: z.string().trim().max(5000).default(''),
  tasksCompleted: z.number().int().min(0).max(1_000_000).default(0),
  totalTasks: z.number().int().min(0).max(1_000_000).default(0),
  memberIds: z.array(z.string().uuid()).max(500).default([]),
}).refine(data => data.spent <= data.budget, {
  message: 'Spent amount cannot exceed the project budget.',
  path: ['spent'],
}).refine(data => data.totalTasks >= data.tasksCompleted, {
  message: 'Total tasks cannot be less than completed tasks.',
  path: ['totalTasks'],
});

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

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;

    const employee = await linkedEmployee(user.id);
    if (!employee) return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });

    const projectRows = user.role === 'admin'
      ? await db.select({ project: projects, lead: employees })
        .from(projects)
        .leftJoin(employees, eq(projects.leadEmployeeId, employees.id))
        .orderBy(asc(projects.name))
      : await db.select({ project: projects, lead: employees })
        .from(projects)
        .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
        .leftJoin(employees, eq(projects.leadEmployeeId, employees.id))
        .where(eq(projectMembers.employeeId, employee.id))
        .orderBy(asc(projects.name));

    const projectIds = projectRows.map(row => row.project.id);
    const teams = projectIds.length
      ? await db.select({ projectId: projectMembers.projectId, employee: employees, role: projectMembers.role })
        .from(projectMembers)
        .innerJoin(employees, eq(projectMembers.employeeId, employees.id))
        .where(inArray(projectMembers.projectId, projectIds))
      : [];
    const teamByProject = new Map<string, typeof teams>();
    for (const member of teams) {
      teamByProject.set(member.projectId, [...(teamByProject.get(member.projectId) ?? []), member]);
    }

    return {
      projects: projectRows.map(({ project, lead }) => ({
        id: project.id,
        name: project.name,
        code: project.code,
        client: project.client,
        status: project.status,
        progress: project.progress,
        budget: project.budget,
        spent: project.spent,
        deadline: project.deadline,
        startDate: project.startDate,
        leadId: lead?.id ?? '',
        leadName: lead ? `${lead.firstName} ${lead.lastName}` : 'Unassigned',
        leadAvatar: lead?.avatar ?? '/favicon.svg',
        team: (teamByProject.get(project.id) ?? []).map(({ employee: member, role }) => ({
          id: member.id,
          name: `${member.firstName} ${member.lastName}`,
          avatar: member.avatar,
          role,
        })),
        description: project.description,
        tasksCompleted: project.tasksCompleted,
        totalTasks: project.totalTasks,
      })),
    };
  });

  app.post('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });

    const parsed = projectInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Check the project details and try again.' });
    const data = parsed.data;
    const startDate = data.startDate ?? new Date().toISOString().slice(0, 10);
    if (data.deadline < startDate) {
      return reply.code(400).send({ error: 'Project deadline must be on or after its start date.' });
    }

    const [lead] = await db.select({ id: employees.id }).from(employees)
      .where(eq(employees.userId, user.id)).limit(1);
    const memberIds = [...new Set([...data.memberIds, ...(lead ? [lead.id] : [])])];
    const validMembers = memberIds.length
      ? await db.select({ id: employees.id }).from(employees).where(inArray(employees.id, memberIds))
      : [];
    if (validMembers.length !== memberIds.length) {
      return reply.code(400).send({ error: 'One or more selected team members do not exist.' });
    }

    const code = `AAV-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const result = await db.transaction(async tx => {
      const [project] = await tx.insert(projects).values({
        name: data.name,
        code,
        client: data.client,
        status: data.status,
        progress: data.progress,
        budget: data.budget,
        spent: data.spent,
        startDate,
        deadline: data.deadline,
        leadEmployeeId: lead?.id ?? null,
        description: data.description,
        tasksCompleted: data.tasksCompleted,
        totalTasks: data.totalTasks,
      }).returning();
      if (memberIds.length) {
        await tx.insert(projectMembers).values(memberIds.map(employeeId => ({
          projectId: project.id,
          employeeId,
          role: employeeId === lead?.id ? 'Lead' : 'Team Member',
        })));
      }
      return project;
    });

    return reply.code(201).send({ projectId: result.id, code: result.code });
  });

  app.patch('/:id', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = z.object({ progress: z.number().int().min(0).max(100) }).safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'Invalid project ID.' });
    if (!parsed.success) return reply.code(400).send({ error: 'Provide valid project progress.' });
    const [project] = await db.update(projects).set({
      progress: parsed.data.progress,
      updatedAt: new Date(),
    }).where(eq(projects.id, params.data.id)).returning({ id: projects.id });
    if (!project) return reply.code(404).send({ error: 'Project not found.' });
    return { progress: parsed.data.progress };
  });
}
