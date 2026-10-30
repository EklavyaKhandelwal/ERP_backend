import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, type PublicUser } from '../auth.js';
import { db } from '../db/index.js';
import { employees, projectMembers, projectTasks, projects } from '../db/schema.js';
import { insertUserNotifications } from '../notifications.js';

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
});
const taskStatus = z.enum(['To Do', 'In Progress', 'Blocked', 'Done']);
const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().max(3000).default(''),
  assignedEmployeeId: z.string().uuid(),
  dueDate: z.string().date().nullable(),
});
const adminTaskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(180).optional(),
  description: z.string().trim().max(3000).optional(),
  assignedEmployeeId: z.string().uuid().optional(),
  dueDate: z.string().date().nullable().optional(),
  status: taskStatus.optional(),
  updateNote: z.string().trim().max(2000).optional(),
}).strict().refine(data => Object.keys(data).length > 0);
const employeeTaskUpdateSchema = z.object({
  status: taskStatus,
  updateNote: z.string().trim().max(2000),
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

type ProjectTaskExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function getProjectTaskProgress(executor: ProjectTaskExecutor, projectId: string) {
  const taskRecords = await executor.select({
    status: projectTasks.status,
  }).from(projectTasks).where(eq(projectTasks.projectId, projectId));
  const totalTasks = taskRecords.length;
  const tasksCompleted = taskRecords.filter(task => task.status === 'Done').length;
  const progress = totalTasks ? Math.round((tasksCompleted / totalTasks) * 100) : 0;
  return { totalTasks, tasksCompleted, progress };
}

async function updateProjectTaskProgress(executor: ProjectTaskExecutor, projectId: string) {
  const taskProgress = await getProjectTaskProgress(executor, projectId);
  const { totalTasks, tasksCompleted, progress } = taskProgress;
  await executor.update(projects).set({ totalTasks, tasksCompleted, progress, updatedAt: new Date() })
    .where(eq(projects.id, projectId));
  return taskProgress;
}

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;

    type ProjectRow = {
      project: typeof projects.$inferSelect;
      lead: typeof employees.$inferSelect | null;
    };
    let projectRows: ProjectRow[];
    if (user.role === 'admin') {
      projectRows = await db.select({ project: projects, lead: employees })
        .from(projects)
        .leftJoin(employees, eq(projects.leadEmployeeId, employees.id))
        .orderBy(asc(projects.name));
    } else {
      const employee = await linkedEmployee(user.id);
      if (!employee) return reply.code(403).send({ error: 'Your account does not have a linked employee profile.' });
      projectRows = await db.select({ project: projects, lead: employees })
        .from(projects)
        .innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
        .leftJoin(employees, eq(projects.leadEmployeeId, employees.id))
        .where(eq(projectMembers.employeeId, employee.id))
        .orderBy(asc(projects.name));
    }

    const projectIds = projectRows.map(row => row.project.id);
    const [teams, taskRows] = await Promise.all([
      projectIds.length
        ? db.select({ projectId: projectMembers.projectId, employee: employees, role: projectMembers.role })
          .from(projectMembers)
          .innerJoin(employees, eq(projectMembers.employeeId, employees.id))
          .where(inArray(projectMembers.projectId, projectIds))
        : Promise.resolve([]),
      projectIds.length
        ? db.select({ task: projectTasks, employee: employees })
          .from(projectTasks)
          .innerJoin(employees, eq(projectTasks.assignedEmployeeId, employees.id))
          .where(inArray(projectTasks.projectId, projectIds))
          .orderBy(asc(projectTasks.dueDate), asc(projectTasks.createdAt))
        : Promise.resolve([]),
    ]);
    const teamByProject = new Map<string, typeof teams>();
    for (const member of teams) {
      teamByProject.set(member.projectId, [...(teamByProject.get(member.projectId) ?? []), member]);
    }
    const tasksByProject = new Map<string, typeof taskRows>();
    for (const task of taskRows) {
      tasksByProject.set(task.task.projectId, [...(tasksByProject.get(task.task.projectId) ?? []), task]);
    }

    return {
      projects: projectRows.map(({ project, lead }) => {
        const tasks = (tasksByProject.get(project.id) ?? []).map(({ task, employee: assignee }) => ({
          id: task.id,
          projectId: task.projectId,
          title: task.title,
          description: task.description,
          assignedEmployeeId: assignee.id,
          assignedEmployeeName: `${assignee.firstName} ${assignee.lastName}`,
          assignedEmployeeAvatar: assignee.avatar,
          status: task.status,
          dueDate: task.dueDate,
          updateNote: task.updateNote,
          updatedAt: task.updatedAt.toISOString(),
        }));
        const tasksCompleted = tasks.filter(task => task.status === 'Done').length;
        const totalTasks = tasks.length;
        return {
          id: project.id,
          name: project.name,
          code: project.code,
          client: project.client,
          status: project.status,
          progress: totalTasks ? Math.round((tasksCompleted / totalTasks) * 100) : 0,
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
          tasksCompleted,
          totalTasks,
          tasks,
        };
      }),
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
        progress: 0,
        budget: data.budget,
        spent: data.spent,
        startDate,
        deadline: data.deadline,
        leadEmployeeId: lead?.id ?? null,
        description: data.description,
        tasksCompleted: 0,
        totalTasks: 0,
      }).returning();
      if (memberIds.length) {
        await tx.insert(projectMembers).values(memberIds.map(employeeId => ({
          projectId: project.id,
          employeeId,
          role: employeeId === lead?.id ? 'Lead' : 'Team Member',
        })));
        const members = await tx.select({ userId: employees.userId })
          .from(employees)
          .where(inArray(employees.id, memberIds));
        const recipientIds = members.flatMap(member => member.userId ? [member.userId] : []);
        await insertUserNotifications(
          tx,
          recipientIds,
          `You have been added to ${project.name}. Project deadline: ${project.deadline}.`,
          'projectMilestones',
        );
      }
      return project;
    });

    return reply.code(201).send({ projectId: result.id, code: result.code });
  });

  app.post('/:id/tasks', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Administrator access required.' });
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const parsed = createTaskSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: 'Invalid project ID.' });
    if (!parsed.success) return reply.code(400).send({ error: 'Provide a task title, project team assignee, and valid due date.' });

    const project = await db.select({ id: projects.id, name: projects.name }).from(projects)
      .where(eq(projects.id, params.data.id)).limit(1);
    if (!project[0]) return reply.code(404).send({ error: 'Project not found.' });

    const membership = await db.select({ employeeId: projectMembers.employeeId })
      .from(projectMembers)
      .where(and(
        eq(projectMembers.projectId, params.data.id),
        eq(projectMembers.employeeId, parsed.data.assignedEmployeeId),
      )).limit(1);
    if (!membership[0]) {
      return reply.code(400).send({ error: 'Tasks can only be assigned to employees on this project team.' });
    }

    const task = await db.transaction(async tx => {
      const [lockedProject] = await tx.select({ id: projects.id }).from(projects)
        .where(eq(projects.id, params.data.id))
        .for('update')
        .limit(1);
      if (!lockedProject) return null;
      const [created] = await tx.insert(projectTasks).values({
        projectId: params.data.id,
        assignedEmployeeId: parsed.data.assignedEmployeeId,
        createdByUserId: user.id,
        title: parsed.data.title,
        description: parsed.data.description,
        dueDate: parsed.data.dueDate,
      }).returning({ id: projectTasks.id });
      await updateProjectTaskProgress(tx, params.data.id);
      return created;
    });
    if (!task) return reply.code(404).send({ error: 'Project not found.' });

    const [assignee] = await db.select({ userId: employees.userId }).from(employees)
      .where(eq(employees.id, parsed.data.assignedEmployeeId)).limit(1);
    if (assignee?.userId) {
      await insertUserNotifications(
        db,
        [assignee.userId],
        `A new task was assigned to you in ${project[0].name}: ${parsed.data.title}.`,
        'projectMilestones',
      );
    }
    return reply.code(201).send({ taskId: task.id });
  });

  app.patch('/:projectId/tasks/:taskId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const user = await getUser(request, reply);
    if (!user) return reply;
    const params = z.object({ projectId: z.string().uuid(), taskId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid project or task ID.' });

    const parsed = user.role === 'admin'
      ? adminTaskUpdateSchema.safeParse(request.body)
      : employeeTaskUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: user.role === 'admin'
          ? 'Provide valid task details to update.'
          : 'Provide a task status and an update note of no more than 2,000 characters.',
      });
    }
    if (parsed.data.status === 'Blocked'
      && !(typeof parsed.data.updateNote === 'string' && parsed.data.updateNote.trim())) {
      return reply.code(400).send({ error: 'Add an update note explaining why the task is blocked.' });
    }

    const task = await db.select().from(projectTasks)
      .where(and(eq(projectTasks.id, params.data.taskId), eq(projectTasks.projectId, params.data.projectId)))
      .limit(1);
    if (!task[0]) return reply.code(404).send({ error: 'Task not found in this project.' });
    if (user.role === 'employee') {
      const employee = await linkedEmployee(user.id);
      if (!employee || employee.id !== task[0].assignedEmployeeId) {
        return reply.code(403).send({ error: 'You can update only tasks assigned to you.' });
      }
    } else if ('assignedEmployeeId' in parsed.data && parsed.data.assignedEmployeeId) {
      const membership = await db.select({ employeeId: projectMembers.employeeId })
        .from(projectMembers)
        .where(and(
          eq(projectMembers.projectId, params.data.projectId),
          eq(projectMembers.employeeId, parsed.data.assignedEmployeeId),
        )).limit(1);
      if (!membership[0]) {
        return reply.code(400).send({ error: 'Tasks can only be assigned to employees on this project team.' });
      }
    }

    const updateData = user.role === 'admin'
      ? parsed.data
      : { status: parsed.data.status, updateNote: parsed.data.updateNote };
    const result = await db.transaction(async tx => {
      await tx.select({ id: projects.id }).from(projects)
        .where(eq(projects.id, params.data.projectId))
        .for('update')
        .limit(1);
      const [lockedTask] = await tx.select().from(projectTasks)
        .where(and(eq(projectTasks.id, params.data.taskId), eq(projectTasks.projectId, params.data.projectId)))
        .for('update')
        .limit(1);
      if (!lockedTask) return { error: 'Task no longer exists.', status: 404 as const };
      if (user.role === 'employee') {
        const employee = await linkedEmployee(user.id);
        if (!employee || employee.id !== lockedTask.assignedEmployeeId) {
          return { error: 'You can update only tasks assigned to you.', status: 403 as const };
        }
      } else if ('assignedEmployeeId' in parsed.data && parsed.data.assignedEmployeeId) {
        const membership = await tx.select({ employeeId: projectMembers.employeeId })
          .from(projectMembers)
          .where(and(
            eq(projectMembers.projectId, params.data.projectId),
            eq(projectMembers.employeeId, parsed.data.assignedEmployeeId),
          )).limit(1);
        if (!membership[0]) {
          return { error: 'Tasks can only be assigned to employees on this project team.', status: 400 as const };
        }
      }

      const previousProgress = await getProjectTaskProgress(tx, params.data.projectId);
      const [updatedTask] = await tx.update(projectTasks).set({
        ...updateData,
        updatedAt: new Date(),
      }).where(eq(projectTasks.id, lockedTask.id)).returning();
      const nextProgress = await updateProjectTaskProgress(tx, params.data.projectId);
      return { updatedTask, previousProgress, nextProgress, previousTask: lockedTask };
    });
    if ('status' in result && result.status) return reply.code(result.status).send({ error: result.error });
    const { updatedTask: updated, previousProgress, nextProgress, previousTask } = result;
    if (!updated) return reply.code(404).send({ error: 'Task no longer exists.' });

    if ([25, 50, 75, 100].includes(nextProgress.progress) && nextProgress.progress > previousProgress.progress) {
      const [project] = await db.select({ name: projects.name }).from(projects)
        .where(eq(projects.id, params.data.projectId)).limit(1);
      const members = await db.select({ userId: employees.userId })
        .from(projectMembers)
        .innerJoin(employees, eq(projectMembers.employeeId, employees.id))
        .where(and(
          eq(projectMembers.projectId, params.data.projectId),
          isNotNull(employees.userId),
        ));
      const recipientIds = members.flatMap(member => member.userId ? [member.userId] : []);
      if (project) {
        await insertUserNotifications(
          db,
          recipientIds,
          `${project.name} reached ${nextProgress.progress}% task completion.`,
          'projectMilestones',
        );
      }
    }

    const reassignedEmployeeId = 'assignedEmployeeId' in parsed.data ? parsed.data.assignedEmployeeId : undefined;
    if (user.role === 'admin' && reassignedEmployeeId
      && reassignedEmployeeId !== previousTask.assignedEmployeeId) {
      const [assignee] = await db.select({ userId: employees.userId }).from(employees)
        .where(eq(employees.id, reassignedEmployeeId)).limit(1);
      if (assignee?.userId) {
        await insertUserNotifications(
          db,
          [assignee.userId],
          `A project task was assigned to you: ${updated.title}.`,
          'projectMilestones',
        );
      }
    }

    return { task: updated };
  });
}
