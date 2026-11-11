import {
  boolean,
  customType,
  date,
  integer,
  index,
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
  phone: text('phone').notNull().default(''),
  dateOfBirth: date('date_of_birth', { mode: 'string' }),
  department: text('department').notNull().default('Unassigned'),
  designation: text('designation').notNull().default('Team member'),
  location: text('location').notNull().default('Remote'),
  avatar: text('avatar'),
  salesAccess: boolean('sales_access').notNull().default(false),
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
  bankName: text('bank_name').notNull().default(''),
  bankAccountNumber: text('bank_account_number').notNull().default(''),
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
}, table => [index('employees_name_idx').on(table.lastName, table.firstName)]);

const documentBytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const employeeDocuments = pgTable('employee_documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  documentType: text('document_type', {
    enum: ['offer_letter', 'education_certificate', 'government_id', 'bond_agreement', 'nda'],
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
}, table => [
  index('leave_requests_employee_status_start_idx').on(table.employeeId, table.status, table.startDate),
  index('leave_requests_status_start_created_idx').on(table.status, table.startDate, table.createdAt),
]);

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

export const companyHolidays = pgTable('company_holidays', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  description: text('description').notNull().default(''),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  updatedByUserId: uuid('updated_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('company_holidays_dates_idx').on(table.startDate, table.endDate),
]);

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
}, table => [
  uniqueIndex('project_members_project_employee_idx').on(table.projectId, table.employeeId),
  index('project_members_employee_project_idx').on(table.employeeId, table.projectId),
]);

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
}, table => [index('project_tasks_project_due_created_idx').on(table.projectId, table.dueDate, table.createdAt)]);

export const attendanceRecords = pgTable('attendance_records', {
  id: uuid('id').defaultRandom().primaryKey(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  clockInAt: timestamp('clock_in_at', { withTimezone: true }).notNull(),
  clockOutAt: timestamp('clock_out_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('attendance_records_one_open_per_employee_idx')
    .on(table.employeeId)
    .where(sql`${table.clockOutAt} IS NULL`),
  uniqueIndex('attendance_records_employee_clock_in_idx').on(table.employeeId, table.clockInAt),
]);

export const attendanceAdjustments = pgTable('attendance_adjustments', {
  id: uuid('id').defaultRandom().primaryKey(),
  attendanceRecordId: uuid('attendance_record_id').notNull().references(() => attendanceRecords.id, { onDelete: 'cascade' }),
  changedByUserId: uuid('changed_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  reason: text('reason').notNull(),
  previousClockInAt: timestamp('previous_clock_in_at', { withTimezone: true }).notNull(),
  previousClockOutAt: timestamp('previous_clock_out_at', { withTimezone: true }),
  newClockInAt: timestamp('new_clock_in_at', { withTimezone: true }).notNull(),
  newClockOutAt: timestamp('new_clock_out_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('attendance_adjustments_record_created_idx').on(table.attendanceRecordId, table.createdAt),
]);

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
}, table => [
  uniqueIndex('timesheets_employee_week_idx').on(table.employeeId, table.weekStart),
  index('timesheets_status_submitted_idx').on(table.status, table.submittedOn),
]);

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
}, table => [index('timesheet_entries_timesheet_idx').on(table.timesheetId)]);

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
  basicSalaryMaster: numeric('basic_salary_master', { precision: 14, scale: 2, mode: 'number' }).notNull().default(0),
  hraMaster: numeric('hra_master', { precision: 14, scale: 2, mode: 'number' }).notNull().default(0),
  specialAllowanceMaster: numeric('special_allowance_master', { precision: 14, scale: 2, mode: 'number' }).notNull().default(0),
  bonusMaster: numeric('bonus_master', { precision: 14, scale: 2, mode: 'number' }).notNull().default(0),
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
  effectiveWorkDays: integer('effective_work_days').notNull().default(0),
  lossOfPayDays: integer('loss_of_pay_days').notNull().default(0),
  bankName: text('bank_name').notNull().default(''),
  bankAccountNumber: text('bank_account_number').notNull().default(''),
  panNumber: text('pan_number').notNull().default(''),
  providentFundNumber: text('provident_fund_number').notNull().default(''),
  providentFundUan: text('provident_fund_uan').notNull().default(''),
  otherDetails: text('other_details').notNull().default(''),
  payslipStatus: text('payslip_status', { enum: ['Draft', 'Published'] }).notNull().default('Draft'),
  revision: integer('revision').notNull().default(1),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  status: text('status', { enum: ['Paid', 'Processing', 'Pending'] }).notNull().default('Pending'),
  paymentDate: date('payment_date', { mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('payroll_records_run_employee_idx').on(table.runId, table.employeeId),
  index('payroll_records_employee_created_idx').on(table.employeeId, table.createdAt),
]);

export const payrollRecordRevisions = pgTable('payroll_record_revisions', {
  id: uuid('id').defaultRandom().primaryKey(),
  payrollRecordId: uuid('payroll_record_id').notNull().references(() => payrollRecords.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  changedByUserId: uuid('changed_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  note: text('note').notNull(),
  snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('payroll_record_revisions_record_revision_idx').on(table.payrollRecordId, table.revision),
  index('payroll_record_revisions_record_created_idx').on(table.payrollRecordId, table.createdAt),
]);

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
  approvedNoticeDays: integer('approved_notice_days'),
  proposedLastDay: date('proposed_last_day', { mode: 'string' }).notNull(),
  reason: text('reason', {
    enum: ['Career growth', 'Higher studies', 'Personal reasons', 'Relocation', 'Health reasons', 'Other'],
  }).notNull(),
  remarks: text('remarks').notNull(),
  status: text('status', { enum: ['Pending', 'Approved', 'Rejected'] }).notNull().default('Pending'),
  assignedToUserId: uuid('assigned_to_user_id').references(() => users.id, { onDelete: 'set null' }),
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

export const resignationPolicies = pgTable('resignation_policies', {
  id: integer('id').primaryKey().default(1),
  noticeDays: integer('notice_days').notNull().default(30),
  reviewReminderDays: integer('review_reminder_days').notNull().default(7),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const resignationPolicyHistory = pgTable('resignation_policy_history', {
  id: serial('id').primaryKey(),
  noticeDays: integer('notice_days').notNull(),
  reviewReminderDays: integer('review_reminder_days').notNull().default(7),
  changedByUserId: uuid('changed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const resignationEvents = pgTable('resignation_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  resignationId: uuid('resignation_id').notNull().references(() => resignations.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  description: text('description').notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('resignation_events_application_created_idx').on(table.resignationId, table.createdAt)]);

export const resignationChecklistItems = pgTable('resignation_checklist_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  resignationId: uuid('resignation_id').notNull().references(() => resignations.id, { onDelete: 'cascade' }),
  itemKey: text('item_key').notNull(),
  title: text('title').notNull(),
  status: text('status', { enum: ['Pending', 'In progress', 'Completed'] }).notNull().default('Pending'),
  responsibleParty: text('responsible_party').notNull().default(''),
  dueDate: date('due_date', { mode: 'string' }),
  note: text('note').notNull().default(''),
  updatedByUserId: uuid('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('resignation_checklist_application_item_idx').on(table.resignationId, table.itemKey),
  index('resignation_checklist_application_idx').on(table.resignationId),
]);

export const salesAccounts = pgTable('sales_accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  companyName: text('company_name').notNull(),
  industry: text('industry').notNull().default(''),
  website: text('website').notNull().default(''),
  linkedinUrl: text('linkedin_url').notNull().default(''),
  location: text('location').notNull().default(''),
  ownerEmployeeId: uuid('owner_employee_id').notNull().references(() => employees.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['Prospect', 'Active'] }).notNull().default('Prospect'),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('sales_accounts_owner_status_idx').on(table.ownerEmployeeId, table.status),
  index('sales_accounts_name_idx').on(table.companyName),
]);

export const salesTechnologies = pgTable('sales_technologies', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => salesAccounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [uniqueIndex('sales_technologies_account_name_idx').on(table.accountId, table.name)]);

export const salesContacts = pgTable('sales_contacts', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => salesAccounts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  designation: text('designation').notNull().default(''),
  email: text('email').notNull().default(''),
  phone: text('phone').notNull().default(''),
  linkedinUrl: text('linkedin_url').notNull().default(''),
  status: text('status', { enum: ['Active', 'Inactive'] }).notNull().default('Active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('sales_contacts_account_idx').on(table.accountId)]);

export const salesActivities = pgTable('sales_activities', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => salesAccounts.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => salesContacts.id, { onDelete: 'set null' }),
  type: text('type', { enum: ['Call', 'Email', 'Meeting', 'LinkedIn outreach', 'Follow-up'] }).notNull(),
  activityDate: date('activity_date', { mode: 'string' }).notNull(),
  remarks: text('remarks').notNull(),
  nextFollowUpDate: date('next_follow_up_date', { mode: 'string' }),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('sales_activities_account_date_idx').on(table.accountId, table.activityDate)]);

export const salesLeads = pgTable('sales_leads', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => salesAccounts.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => salesContacts.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  serviceInterest: text('service_interest').notNull(),
  source: text('source').notNull(),
  status: text('status', { enum: ['New', 'Contacted', 'Qualified', 'Disqualified', 'Converted'] }).notNull().default('New'),
  assignedEmployeeId: uuid('assigned_employee_id').notNull().references(() => employees.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('sales_leads_account_idx').on(table.accountId)]);

export const salesOpportunities = pgTable('sales_opportunities', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => salesAccounts.id, { onDelete: 'cascade' }),
  contactId: uuid('contact_id').references(() => salesContacts.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  serviceRequired: text('service_required').notNull(),
  stage: text('stage', { enum: ['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Won', 'Lost'] }).notNull().default('Prospecting'),
  expectedClosingDate: date('expected_closing_date', { mode: 'string' }),
  notes: text('notes').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('sales_opportunities_account_idx').on(table.accountId)]);

export const salesNotes = pgTable('sales_notes', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id').notNull().references(() => salesAccounts.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [index('sales_notes_account_created_idx').on(table.accountId, table.createdAt)]);

export const notifications = pgTable('notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  category: text('category'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
}, table => [index('notifications_user_created_idx').on(table.userId, table.createdAt)]);

export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  preferences: jsonb('preferences').$type<Record<string, boolean>>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
