CREATE INDEX "employees_name_idx" ON "employees" USING btree ("last_name","first_name");--> statement-breakpoint
CREATE INDEX "leave_requests_employee_status_start_idx" ON "leave_requests" USING btree ("employee_id","status","start_date");--> statement-breakpoint
CREATE INDEX "leave_requests_status_start_created_idx" ON "leave_requests" USING btree ("status","start_date","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "payroll_records_employee_created_idx" ON "payroll_records" USING btree ("employee_id","created_at");--> statement-breakpoint
CREATE INDEX "project_members_employee_project_idx" ON "project_members" USING btree ("employee_id","project_id");--> statement-breakpoint
CREATE INDEX "project_tasks_project_due_created_idx" ON "project_tasks" USING btree ("project_id","due_date","created_at");--> statement-breakpoint
CREATE INDEX "timesheet_entries_timesheet_idx" ON "timesheet_entries" USING btree ("timesheet_id");--> statement-breakpoint
CREATE INDEX "timesheets_status_submitted_idx" ON "timesheets" USING btree ("status","submitted_on");