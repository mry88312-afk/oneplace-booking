import { request } from 'node:https';
import type { RequestHandler } from 'express';
import { bookingEntryParams, bookingCardAction } from '../shared/bookingEntry';

const origin = 'https://booking.oneplace.com.tw';
const entry = 'https://liff.line.me/2006833424-kPq8efDV';
const oldHost = 'oneplace-booking.zeabur.app';
const machines = new Set(['/api/line/inbound', '/api/outreach/run', '/api/outreach/rent-reminders',
  '/api/outreach/scan-checkout', '/api/outreach/test-send', '/api/outreach/enqueue']);

export function legacyDestination(path: string, search: string) {
  const params = bookingEntryParams(search);
  const type = path === '/book/renewal' ? 'renewal' : path === '/book/checkout' ? 'checkout' : params.get('type');
  if ((path === '/' || path === '/book/renewal' || path === '/book/checkout') && (type === 'renewal' || type === 'checkout')) {
    const target = new URL(entry);
    target.searchParams.set('type', type);
    const card = bookingCardAction(params);
    if (card) {
      target.searchParams.set(card.action, String(card.bookingId));
      const dataset = params.get('dataset');
      if (dataset) target.searchParams.set('dataset', dataset);
    } else if (/^(\d{8}|\d{12})$/.test(params.get('t') || '')) target.searchParams.set('t', params.get('t')!);
    return target.href;
  }
  if (path === '/' && !search) return origin + '/admin';
  // Keep the destination host fixed even for a request path beginning with //.
  return origin + path + search;
}

export const forwardOldBooking: RequestHandler = (req, res, next) => {
  if (req.hostname !== oldHost) return next();
  const url = new URL(origin + req.originalUrl);
  const path = url.pathname;
  res.set('Cache-Control', 'no-store').set('X-OnePlace-Forward', 'booking-gcp');
  if (req.method === 'POST' && machines.has(path) || path === '/healthz' && ['GET','HEAD'].includes(req.method)) {
    const headers: Record<string, string> = {};
    for (const key of ['content-type','content-length','x-inbound-secret','x-outreach-secret']) {
      const value = req.get(key);
      if (value) headers[key] = value;
    }
    const upstream = request(origin + path, { method: req.method, headers, timeout: 120000 }, reply => {
      res.status(reply.statusCode || 502);
      if (reply.headers['content-type']) res.set('Content-Type', reply.headers['content-type']);
      const fallback = reply.headers['x-jgb-fallback'];
      if (typeof fallback === 'string') res.set('X-JGB-Fallback', fallback);
      reply.on('error', () => res.destroy());
      reply.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) res.sendStatus(502); else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD' || (req.method === 'POST' && path.startsWith('/f/'))) {
    res.redirect(307, legacyDestination(path, url.search));
    return;
  }
  res.status(409).json({ message: '預約服務已搬遷，請重新開啟原連結。' });
};

