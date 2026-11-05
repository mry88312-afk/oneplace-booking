/** Local-only integration fixture. Never loads .env; every external fetch is blocked.
 * Pass a checkout of tenant-form-liff main to exercise its actual native intake. */
import express from 'express';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import superjson from 'superjson';

const depositRoot = process.argv[2];
if (!depositRoot) throw new Error('Pass the tenant-form-liff checkout path');
const require = createRequire(import.meta.url);
const { createCodec, createIntake } = require(path.resolve(depositRoot, 'server/services/deposit-sync.js'));
const codec = createCodec(Buffer.alloc(32, 1).toString('base64'));
const account = '92564123456780';
const phone = '0912345678';
const token = 'a'.repeat(48);
const tenant: Record<string, unknown> = { _ragicId: 42, '1007372': phone, '1007383': 'Ufixture', '1007373': '合成續約租客', '1007374': 'FIXTURE-ID', '1007542': 'fixture@example.invalid', '1007377': '合成職業', '1021087': account };
const jobs = new Map<string, any>();
const tokens = new Map<string, string>();
const counters = { otp: 0, submissions: 0, jobs: 0, polls: 0, profileWrites: 0, bookingWrites: 0, blockedExternal: 0 };
let failStatus = false;
const evidence = () => writeFileSync('.cache/remittance-preview-evidence.json', JSON.stringify({ counters, jobs: [...jobs.values()].map(j => ({ id: j.id, state: j.state, ready: Boolean(j.jgb_verified_at) })), profile: { email: tenant['1007542'], job: tenant['1007377'] } }, null, 2));
const store = {
  byToken: async (hash: string) => jobs.get(tokens.get(hash) || ''),
  get: async (id: string) => jobs.get(id),
  enqueue: async (input: any) => {
    const existing = [...jobs.values()].find(j => j.account_key === input.accountKey);
    if (existing && existing.digest !== input.digest) throw Object.assign(new Error('ACCOUNT_CONTENT_CONFLICT'), { permanent: true });
    const job = existing || { id: randomUUID(), account_key: input.accountKey, digest: input.digest, payload: input.payload, state: 'queued', jgb_verified_at: null };
    if (!existing) counters.jobs++;
    jobs.set(job.id, job); tokens.set(input.tokenHash, job.id); evidence(); return job;
  },
};
const intake = createIntake({ store, codec, generateAccount: () => account, verify: (t: string, p: string) => t === token && p === phone, consume: () => true, credits: () => null });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
Object.assign(process.env, { RAGIC_API_KEY: 'fixture-only', BOOKING_DATASET_ID: 'fixture-only', BOOKING_WRITES_ENABLED: 'true' });
globalThis.fetch = async (input, init: RequestInit = {}) => {
  const url = new URL(String(input));
  if (url.origin === 'https://ap13.ragic.com' && url.pathname.startsWith('/OnePlaceLiving/for-system-use/2')) {
    if (init.method === 'POST') { Object.assign(tenant, Object.fromEntries(new URLSearchParams(String(init.body)))); counters.profileWrites++; evidence(); return json({ status: 'SUCCESS' }); }
    return json({ 42: tenant });
  }
  if (url.origin === 'https://deposit.zeabur.app') {
    if (url.pathname === '/api/submit') {
      counters.submissions++;
      try { return json(await intake.submit(JSON.parse(String(init.body))), 202); }
      catch { return json({ success: false }, 409); }
    }
    if (url.pathname.startsWith('/api/submissions/')) {
      counters.polls++; evidence();
      if (failStatus) return json({ success: false }, 503);
      const value = await intake.status(url.pathname.split('/').at(-1), new Headers(init.headers).get('Authorization')?.replace('Bearer ', ''));
      return json(value || { success: false }, value ? 200 : 404);
    }
  }
  counters.blockedExternal++; evidence(); throw new Error('Fixture blocked external request');
};
const { bookingRouter } = await import('../server/routers/property/booking');
const caller = bookingRouter.createCaller({ req: {} as any, res: {} as any, user: null, adminPassword: null });
const template = JSON.parse(readFileSync('.cache/renewal-public.json', 'utf8')).result.data.json;
template.liffId = null;
const app = express(); app.use(express.json());
app.post('/fixture/deposit/send-otp', (_req, res) => res.json({ success: true }));
app.post('/fixture/deposit/verify-otp', (_req, res) => { counters.otp++; evidence(); res.json({ success: true, message: '驗證成功', verifyToken: token }); });
app.get('/fixture', (_req, res) => res.type('html').send(`<meta charset="utf-8"><h1>合成流程控制台（無正式寫入）</h1><pre>${JSON.stringify(counters, null, 2)}</pre>${['ready','review','offline','online'].map(action => `<form method="post" action="/fixture/${action}"><button>${{ ready: '啟用合成帳號', review: '轉為人工確認', offline: '模擬查詢斷線', online: '恢復查詢' }[action]}</button></form>`).join('')}`));
app.post('/fixture/:action', (req, res) => {
  if (req.params.action === 'offline') failStatus = true;
  if (req.params.action === 'online') failStatus = false;
  if (req.params.action === 'ready') for (const job of jobs.values()) { job.jgb_verified_at = new Date().toISOString(); job.state = 'done'; }
  if (req.params.action === 'review') for (const job of jobs.values()) { job.jgb_verified_at = null; job.state = 'needs_review'; }
  evidence(); res.redirect('/fixture');
});
app.all('/api/trpc/:methods', async (req, res) => {
  const batch = req.query.batch === '1';
  const body = req.method === 'GET' ? JSON.parse(String(req.query.input || '{}')) : req.body;
  const output = await Promise.all(req.params.methods.split(',').map(async (method, index) => {
    const name = method.split('.').at(-1)!;
    const input = (batch ? body[index] : body)?.json || {};
    try {
      let value: unknown;
      if (name === 'getPublicTemplate') value = template;
      else if (name === 'verifyTenantUid') value = { tenantName: '合成續約租客', roomNumber: 'TEST-A', propertyName: '合成案場', phone, email: 'fixture@example.invalid', job: '合成職業', residences: [] };
      else if (name === 'getAvailableSlotsMultiDay') value = { slotsByDate: Object.fromEntries(input.dates.map((date: string) => [date, [{ startTime: `${date}T06:00:00Z`, endTime: `${date}T07:30:00Z`, available: true }]])) };
      else if (name === 'getAvailableSlots') value = { slots: [{ startTime: `${input.date}T06:00:00Z`, endTime: `${input.date}T07:30:00Z`, available: true }], calendarOwner: '合成負責人', calendarId: 'fixture@example.invalid' };
      else if (name === 'submitRenewalRemittance') value = await caller.submitRenewalRemittance(input);
      else if (name === 'getRenewalRemittance') value = await caller.getRenewalRemittance(input);
      else if (name === 'completeRenewalRemittance') value = await caller.completeRenewalRemittance(input);
      else { counters.bookingWrites++; throw new Error('Fixture forbids booking submission'); }
      return { result: { data: superjson.serialize(value) } };
    } catch (error: any) { return { error: { json: { message: error.message, code: -32603, data: { code: error.code || 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: method } } } }; }
  }));
  res.json(batch ? output : output[0]);
});
app.use(express.static('.cache/preview-public'));
app.get('*', (_req, res) => res.sendFile(path.resolve('.cache/preview-public/index.html')));
app.listen(8818, '127.0.0.1', () => console.log('SYNTHETIC ONLY http://127.0.0.1:8818/book/renewal?uid=Ufixture ; control /fixture'));
