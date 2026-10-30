import {
  boolean,
  customType,
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
  isOwner: boolean('is_owner').notNull().default(false),
  hasCompletedSetup: boolean('has_completed_setup').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('users_one_owner_idx').on(table.isOwner).where(sql`${table.isOwner} = true`),
]);

export const adminInviteTokens = pgTable('admin_invite_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
  dateOfBirth: date('date_of_birth', { mode: 'string' }),
  onboardingComplete: boolean('onboarding_complete').notNull().default(false),
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

const documentBytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const employeeDocuments = pgTable('employee_documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  documentType: text('document_type', {
    enum: ['offer_letter', 'education_certificate', 'government_id'],
  }).notNull(),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  content: documentBytes('content').notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('employee_documents_employee_type_idx').on(table.employeeId, table.documentType),
]);

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

export const employeeLeaveBalances = pgTable('employee_leave_balances', {
  id: serial('id').primaryKey(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  year: integer('year').notNull(),
  annualBalance: integer('annual_balance').notNull(),
  annualTotal: integer('annual_total').notNull(),
  sickBalance: integer('sick_balance').notNull(),
  sickTotal: integer('sick_total').notNull(),
  casualBalance: integer('casual_balance').notNull(),
  casualTotal: integer('casual_total').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('employee_leave_balances_employee_year_idx').on(table.employeeId, table.year),
]);

export const leavePolicies = pgTable('leave_policies', {
  id: integer('id').primaryKey().default(1),
  annualDays: integer('annual_days').notNull().default(20),
  sickDays: integer('sick_days').notNull().default(10),
  casualDays: integer('casual_days').notNull().default(6),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const leavePolicyHistory = pgTable('leave_policy_history', {
  id: serial('id').primaryKey(),
  annualDays: integer('annual_days').notNull(),
  sickDays: integer('sick_days').notNull(),
  casualDays: integer('casual_days').notNull(),
  changedByUserId: uuid('changed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
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

export const projectTasks = pgTable('project_tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  assignedEmployeeId: uuid('assigned_employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status', { enum: ['To Do', 'In Progress', 'Blocked', 'Done'] }).notNull().default('To Do'),
  dueDate: date('due_date', { mode: 'string' }),
  updateNote: text('update_note').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const timesheets = pgTable('timesheets', {
  id: uuid('id').defaultRandom().primaryKey(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  weekStart: date('week_start', { mode: 'string' }).notNull(),
  status: text('status', { enum: ['Draft', 'Submitted', 'Approved', 'Rejected'] }).notNull().default('Draft'),
  submittedOn: date('submitted_on', { mode: 'string' }),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  reviewNote: text('review_note'),
  workCompleted: text('work_completed').notNull().default(''),
  nextWeekFocus: text('next_week_focus').notNull().default(''),
  blockers: text('blockers').notNull().default(''),
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
  dailyDescriptions: jsonb('daily_descriptions').$type<{
    mon: string;
    tue: string;
    wed: string;
    thu: string;
    fri: string;
    sat: string;
    sun: string;
  }>().notNull().default({
    mon: '', tue: '', wed: '', thu: '', fri: '', sat: '', sun: '',
  }),
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
  status: text('status', { enum: ['Self Assessment', 'Admin Review', 'Completed'] })
    .notNull().default('Self Assessment'),
  selfRating: numeric('self_rating', { precision: 2, scale: 1, mode: 'number' }),
  selfComments: text('self_comments'),
  goalsAchieved: text('goals_achieved'),
  managerRating: numeric('manager_rating', { precision: 2, scale: 1, mode: 'number' }),
  managerComments: text('manager_comments'),
  overallRating: numeric('overall_rating', { precision: 2, scale: 1, mode: 'number' }),
  selfChallenges: text('self_challenges'),
  nextGoals: text('next_goals'),
  deliveryRating: integer('delivery_rating'),
  qualityRating: integer('quality_rating'),
  ownershipRating: integer('ownership_rating'),
  collaborationRating: integer('collaboration_rating'),
  adminComments: text('admin_comments'),
  completedByUserId: uuid('completed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  completedDate: date('completed_date', { mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('appraisal_reviews_employee_cycle_idx').on(table.employeeId, table.cycle)]);

export const resignations = pgTable('resignations', {
  id: uuid('id').defaultRandom().primaryKey(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  resignationDate: date('resignation_date', { mode: 'string' }).notNull(),
  noticeDays: integer('notice_days').notNull().default(30),
  proposedLastDay: date('proposed_last_day', { mode: 'string' }).notNull(),
  reason: text('reason', {
    enum: ['Career growth', 'Higher studies', 'Personal reasons', 'Relocation', 'Health reasons', 'Other'],
  }).notNull(),
  remarks: text('remarks').notNull(),
  status: text('status', { enum: ['Pending', 'Approved', 'Rejected'] }).notNull().default('Pending'),
  reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewNote: text('review_note'),
  approvedLastDay: date('approved_last_day', { mode: 'string' }),
  escalationNotifiedAt: timestamp('escalation_notified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('resignations_one_pending_per_employee_idx')
    .on(table.employeeId)
    .where(sql`${table.status} = 'Pending'`),
]);

export const notifications = pgTable('notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  category: text('category'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
});

export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  preferences: jsonb('preferences').$type<Record<string, boolean>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
