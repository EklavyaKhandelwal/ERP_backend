import { env } from './env.js';

export function isPasswordResetEmailConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL && env.APP_BASE_URL);
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
    throw new Error(`Resend rejected the password reset email (HTTP ${response.status}).`);
  }
}
