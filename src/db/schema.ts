import {
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  role: text('role', { enum: ['admin', 'employee'] }).notNull(),
  department: text('department').notNull().default('Unassigned'),
  designation: text('designation').notNull().default('Team member'),
  avatar: text('avatar'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const employees = pgTable('employees', {
  id: uuid('id').defaultRandom().primaryKey(),
  employeeNumber: serial('employee_number').notNull().unique(),
  userId: uuid('user_id').unique().references(() => users.id, { onDelete: 'set null' }),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  email: text('email').notNull().unique(),
  phone: text('phone').notNull().default(''),
  avatar: text('avatar').notNull().default('/favicon.svg'),
  role: text('role').notNull().default('employee'),
  department: text('department').notNull(),
  designation: text('designation').notNull(),
  joinDate: text('join_date').notNull(),
  status: text('status', { enum: ['Active', 'On Leave', 'Probation', 'Inactive'] }).notNull().default('Active'),
  salary: numeric('salary', { precision: 12, scale: 2, mode: 'number' }).notNull().default(0),
  location: text('location').notNull().default('Remote'),
  manager: text('manager').notNull().default(''),
  skills: text('skills').array().notNull().default([]),
  annualLeave: integer('annual_leave').notNull().default(20),
  annualLeaveTotal: integer('annual_leave_total').notNull().default(20),
  sickLeave: integer('sick_leave').notNull().default(10),
  sickLeaveTotal: integer('sick_leave_total').notNull().default(10),
  casualLeave: integer('casual_leave').notNull().default(6),
  casualLeaveTotal: integer('casual_leave_total').notNull().default(6),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accountAccessTokens = pgTable('account_access_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  purpose: text('purpose', { enum: ['setup', 'reset'] }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('password_reset_tokens_one_active_user_idx')
    .on(table.userId)
    .where(sql`${table.consumedAt} is null`),
]);

export const leaveRequests = pgTable('leave_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  leaveType: text('leave_type', {
    enum: ['Annual Leave', 'Sick Leave', 'Casual Leave', 'Maternity/Paternity', 'Unpaid Leave'],
  }).notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  days: integer('days').notNull(),
  reason: text('reason').notNull(),
  status: text('status', { enum: ['Pending', 'Approved', 'Rejected'] }).notNull().default('Pending'),
  appliedOn: date('applied_on', { mode: 'string' }).notNull().defaultNow(),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  reviewNote: text('review_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  code: text('code').notNull().unique(),
  client: text('client').notNull(),
  status: text('status', { enum: ['Active', 'In Progress', 'Completed', 'On Hold'] }).notNull().default('Active'),
  progress: integer('progress').notNull().default(0),
  budget: numeric('budget', { precision: 14, scale: 2, mode: 'number' }).notNull().default(0),
  spent: numeric('spent', { precision: 14, scale: 2, mode: 'number' }).notNull().default(0),
  deadline: date('deadline', { mode: 'string' }).notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull().defaultNow(),
  leadEmployeeId: uuid('lead_employee_id').references(() => employees.id, { onDelete: 'set null' }),
  description: text('description').notNull().default(''),
  tasksCompleted: integer('tasks_completed').notNull().default(0),
  totalTasks: integer('total_tasks').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projectMembers = pgTable('project_members', {
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('Team Member'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('project_members_project_employee_idx').on(table.projectId, table.employeeId)]);

export const timesheets = pgTable('timesheets', {
  id: uuid('id').defaultRandom().primaryKey(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  weekStart: date('week_start', { mode: 'string' }).notNull(),
  status: text('status', { enum: ['Draft', 'Submitted', 'Approved', 'Rejected'] }).notNull().default('Draft'),
  submittedOn: date('submitted_on', { mode: 'string' }),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  reviewNote: text('review_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('timesheets_employee_week_idx').on(table.employeeId, table.weekStart)]);

export const timesheetEntries = pgTable('timesheet_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  timesheetId: uuid('timesheet_id').notNull().references(() => timesheets.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'restrict' }),
  taskDescription: text('task_description').notNull(),
  hours: jsonb('hours').$type<{
    mon: number;
    tue: number;
    wed: number;
    thu: number;
    fri: number;
    sat: number;
    sun: number;
  }>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const payrollRuns = pgTable('payroll_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  payPeriod: date('pay_period', { mode: 'string' }).notNull().unique(),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const payrollRecords = pgTable('payroll_records', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').notNull().references(() => payrollRuns.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'restrict' }),
  basicSalary: numeric('basic_salary', { precision: 14, scale: 2, mode: 'number' }).notNull(),
  hra: numeric('hra', { precision: 14, scale: 2, mode: 'number' }).notNull().default(0),
  specialAllowance: numeric('special_allowance', { precision: 14, scale: 2, mode: 'number' }).notNull().default(0),
  bonus: numeric('bonus', { precision: 14, scale: 2, mode: 'number' }).notNull().default(0),
  providentFund: numeric('provident_fund', { precision: 14, scale: 2, mode: 'number' }).notNull().default(0),
  professionalTax: numeric('professional_tax', { precision: 14, scale: 2, mode: 'number' }).notNull().default(0),
  incomeTax: numeric('income_tax', { precision: 14, scale: 2, mode: 'number' }).notNull().default(0),
  totalEarnings: numeric('total_earnings', { precision: 14, scale: 2, mode: 'number' }).notNull(),
  totalDeductions: numeric('total_deductions', { precision: 14, scale: 2, mode: 'number' }).notNull(),
  netPay: numeric('net_pay', { precision: 14, scale: 2, mode: 'number' }).notNull(),
  status: text('status', { enum: ['Paid', 'Processing', 'Pending'] }).notNull().default('Pending'),
  paymentDate: date('payment_date', { mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('payroll_records_run_employee_idx').on(table.runId, table.employeeId)]);

export const appraisalReviews = pgTable('appraisal_reviews', {
  id: uuid('id').defaultRandom().primaryKey(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  cycle: text('cycle').notNull(),
  status: text('status', { enum: ['Self Assessment', 'Manager Review', 'Completed'] })
    .notNull().default('Self Assessment'),
  selfRating: numeric('self_rating', { precision: 2, scale: 1, mode: 'number' }),
  selfComments: text('self_comments'),
  goalsAchieved: text('goals_achieved'),
  managerRating: numeric('manager_rating', { precision: 2, scale: 1, mode: 'number' }),
  managerComments: text('manager_comments'),
  overallRating: numeric('overall_rating', { precision: 2, scale: 1, mode: 'number' }),
  completedByUserId: uuid('completed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  completedDate: date('completed_date', { mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('appraisal_reviews_employee_cycle_idx').on(table.employeeId, table.cycle)]);

export const notifications = pgTable('notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
});
