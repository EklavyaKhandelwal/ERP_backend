import { env } from './env.js';

async function resendErrorDetails(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const payload: unknown = JSON.parse(body);
    if (
      typeof payload === 'object'
      && payload !== null
      && 'message' in payload
      && typeof payload.message === 'string'
    ) {
      return `: ${payload.message}`;
    }
  } catch {
    return '';
  }
  return '';
}

export function isPasswordResetEmailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL && env.APP_BASE_URL);
}

export function isEmployeeAccessEmailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL && env.APP_BASE_URL);
}

export async function sendEmployeeAccessEmail(
  to: string,
  accessUrl: string,
  purpose: 'setup' | 'reset',
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    throw new Error('Resend employee access email settings are incomplete.');
  }

  const isSetup = purpose === 'setup';
  const subject = isSetup ? 'Set up your AAVIL ERP employee account' : 'Reset your AAVIL ERP password';
  const action = isSetup ? 'Set up your account' : 'Reset your password';
  const instruction = isSetup
    ? 'You have been invited to the AAVIL ERP employee workspace. Use this one-time link to set your password and complete onboarding.'
    : 'Use this one-time link to reset your AAVIL ERP password and complete onboarding.';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [to],
      subject,
      text: `${instruction} The link expires in 24 hours:\n\n${accessUrl}\n\nIf you were not expecting this email, you can ignore it.`,
      html: `<p>${instruction} The link expires in 24 hours:</p><p><a href="${accessUrl}">${action}</a></p><p>If you were not expecting this email, you can ignore it.</p>`,
    }),
  });

  if (!response.ok) {
    const details = await resendErrorDetails(response);
    throw new Error(`Resend rejected the employee access email (HTTP ${response.status})${details}.`);
  }
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    throw new Error('Resend password reset email settings are incomplete.');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [to],
      subject: 'Reset your AAVIL ERP password',
      text: `Use this one-time link to reset your AAVIL ERP password. It expires in 60 minutes:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
      html: `<p>Use this one-time link to reset your AAVIL ERP password. It expires in 60 minutes:</p><p><a href="${resetUrl}">Reset your password</a></p><p>If you did not request this, you can ignore this email.</p>`,
    }),
  });

  if (!response.ok) {
    const details = await resendErrorDetails(response);
    throw new Error(`Resend rejected the password reset email (HTTP ${response.status})${details}.`);
  }
}
