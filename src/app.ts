import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerEmployeeRoutes } from './routes/employees.js';
import { registerLeaveRoutes } from './routes/leaves.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerTimesheetRoutes } from './routes/timesheets.js';
import { registerPayrollRoutes } from './routes/payroll.js';
import { registerAppraisalRoutes } from './routes/appraisals.js';
import { registerAccountRoutes } from './routes/accounts.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerResignationEscalation, registerResignationRoutes } from './routes/resignations.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { pool } from './db/index.js';
import { authenticate } from './auth.js';

export function buildApp() {
  const app = Fastify({
    logger: true,
    trustProxy: false,
  });

  app.register(cookie);
  app.register(rateLimit, { global: false });
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (
      path.startsWith('/api/auth/')
      || path === '/api/accounts/complete-setup'
      || path === '/api/accounts/complete-admin-setup'
      || path === '/api/accounts/onboarding'
    ) return;
    const user = await authenticate(request);
    if (user?.role === 'employee' && !user.onboardingComplete) {
      return reply.code(403).send({ error: 'Complete your employee onboarding before accessing the application.' });
    }
  });

  app.get('/api/health', async (_request, reply) => {
    await db.execute(sql`select 1`);
    return reply.send({ status: 'ok' });
  });

  app.register(registerAuthRoutes, { prefix: '/api/auth' });
  app.register(registerEmployeeRoutes, { prefix: '/api/employees' });
  app.register(registerLeaveRoutes, { prefix: '/api/leave-requests' });
  app.register(registerProjectRoutes, { prefix: '/api/projects' });
  app.register(registerTimesheetRoutes, { prefix: '/api/timesheets' });
  app.register(registerPayrollRoutes, { prefix: '/api/payroll' });
  app.register(registerAppraisalRoutes, { prefix: '/api/appraisals' });
  app.register(registerAccountRoutes, { prefix: '/api/accounts' });
  app.register(registerNotificationRoutes, { prefix: '/api/notifications' });
  app.register(registerResignationRoutes, { prefix: '/api/resignations' });
  app.register(registerDashboardRoutes, { prefix: '/api/dashboard' });
  registerResignationEscalation(app);
  app.addHook('onClose', async () => {
    await pool.end();
  });

  return app;
}
