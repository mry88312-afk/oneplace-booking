'use strict';
const express = require('/app/node_modules/express');
const rateLimit = require('/app/node_modules/express-rate-limit');
const { createHmac } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { createGate } = require('/gate/line-session.cjs');

function createGateway(gate, key, upstreamFetch = fetch) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/line-session', rateLimit({ windowMs: 60_000, max: 60 }));
  app.get('/principal', (req, res) => {
    const session = gate.sessionFor(req.get('Cookie'));
    if (!session) return res.sendStatus(403);
    res.set('X-Booking-Subject', session.uid).sendStatus(204);
  });

  // Only these four operations can reach the already-running deposit application.
  // Existing OTPs and receipts stay with the same process and store as the tenant form.
  async function forward(req, res) {
    const cookie = req.get('Cookie') || '';
    const session = gate.sessionFor(cookie);
    if (!session) return res.status(403).json({ success: false, message: '請重新從 LINE 開啟預約。' });
    const time = String(Date.now());
    const payload = [session.uid, time, cookie].join('\n');
    const headers = { Cookie: cookie, 'X-Deposit-Proof': [session.uid, time, createHmac('sha256', key).update(payload).digest('hex')].join('.') };
    if (req.method === 'GET') {
      const receipt = req.get('Authorization');
      if (!/^Bearer [0-9a-f]{64}$/.test(receipt || '')) return res.sendStatus(401);
      headers.Authorization = receipt;
    } else {
      if (!req.is('application/json')) return res.sendStatus(415);
      headers['Content-Type'] = 'application/json';
    }
    try {
      const upstream = await upstreamFetch('http://deposit-core:3000' + req.path, {
        method: req.method, headers, redirect: 'error', signal: AbortSignal.timeout(25000),
        body: req.method === 'POST' ? JSON.stringify(req.body) : undefined,
      });
      const type = upstream.headers.get('content-type') || '';
      if (!type.includes('application/json')) return res.status(502).json({success:false,message:'匯訂服務回應異常，請稍後確認。'});
      res.status(upstream.status).json(await upstream.json());
    } catch {
      res.status(503).json({success:false,message:'匯訂回應尚未確認，請勿重複送件。'});
    }
  }
  app.post(['/api/send-otp','/api/verify-otp','/api/submit'], express.json({limit:'16kb'}), forward);
  app.get(/^\/api\/submissions\/[0-9a-f-]{36}$/, forward);
  gate.install(app, express);
  return app;
}

if (require.main === module) {
  const subjectHash = process.env.PILOT_SUBJECT_FILE && readFileSync(process.env.PILOT_SUBJECT_FILE, 'utf8').trim();
  const key = readFileSync('/run/occupation-proof');
  if (key.length !== 32) throw Error('Invalid deposit proof key');
  const gate = createGate({ tenants: !subjectHash, subjectHash, liffId: '2006833424-znZYKjip' });
  createGateway(gate, key).listen(3000);
}
module.exports = { createGateway };
