import { TRPCError } from '@trpc/server';
import type { RequestHandler } from 'express';

export const TRIAL_MESSAGE = '搬遷測試環境：僅供檢視，不接受預約、不更新資料、不發送通知。';
export const isMigrationTrial = () => process.env.BOOKING_MIGRATION_TRIAL === 'true';

// Fail closed: new procedures are NOT automatically exposed in the trial.
const readProcedures = new Set([
  'booking.getPublicTemplate',
  'booking.getAvailableSlots',
  'booking.getAvailableSlotsMultiDay',
  'booking.resolvePresetSlot',
]);

export function assertTrialProcedure(path: string, type: string) {
  if (isMigrationTrial() && (type !== 'query' || !readProcedures.has(path))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: TRIAL_MESSAGE });
  }
}

export function assertTrialConfiguration() {
  if (!isMigrationTrial()) return;
  if (process.env.BOOKING_WRITES_ENABLED !== 'false') {
    throw new Error('Trial requires BOOKING_WRITES_ENABLED=false');
  }
  for (const key of ['RAGIC_API_KEY', 'SUPABASE_DB_URL', 'OUTREACH_RUN_SECRET',
    'MAIN_SYSTEM_WEBHOOK_URL', 'BOOKING_WEBHOOK_SECRET', 'ADMIN_PASSWORD',
    'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET']) {
    if (process.env[key]) throw new Error(`Trial must not receive ${key}`);
  }
}

/** Runs before ALL routes, including the feedback GET that records responses. */
export const migrationTrialMiddleware: RequestHandler = (req, res, next) => {
  if (!isMigrationTrial()) return next();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  // Also blocks the browser's direct remittance/LINE calls, bypassing this server.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  const isTrpc = req.path.toLowerCase().startsWith('/api/trpc/');
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  const isStatic = req.path === '/healthz' || req.path === '/' || req.path.startsWith('/book/')
    || req.path.startsWith('/assets/') || req.path === '/favicon.ico';
  if (isTrpc || (isRead && isStatic)) return next();
  res.status(403).json({ error: TRIAL_MESSAGE });
};
