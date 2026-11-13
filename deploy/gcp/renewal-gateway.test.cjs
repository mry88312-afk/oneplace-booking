'use strict';
const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const { createGateway } = require('./renewal-gateway.cjs');
const { createGate } = require('/gate/line-session.cjs');
const uid = 'U' + 'a'.repeat(32);
const key = Buffer.alloc(32, 7);
const gate = createGate({ liffId:'2006833424-znZYKjip', subjectHash:createHash('sha256').update(uid).digest('hex'),
  fetchLine: async (_url, opts) => Response.json({ iss:'https://access.line.me', aud:'2006833424', exp:Math.floor(Date.now()/1000)+900,
    sub:opts.body.get('id_token')==='one.two.three' ? uid : 'U'+'b'.repeat(32) }) });
const calls = [];
const server = createGateway(gate,key, async (url,opts) => {
  assert.match(opts.headers.Cookie,/^__Host-booking_line=[0-9a-f]{64}$/);
  const [subject,time,mac]=opts.headers['X-Deposit-Proof'].split('.');
  assert.equal(subject,uid);
  assert.equal(mac,createHmac('sha256',key).update([uid,time,opts.headers.Cookie].join('\n')).digest('hex'));
  calls.push(url);
  return Response.json({success:true});
}).listen(0,'127.0.0.1',async () => {
  try {
    const url='http://127.0.0.1:'+server.address().port;
    const post=(path,body,headers={})=>fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    assert.equal((await post('/api/send-otp',{}, {'X-Deposit-Proof':'forged'})).status,403);
    assert.equal((await post('/line-session',{idToken:'one.two.three'},{Origin:'https://other.test'})).status,403);
    const origin={Origin:'https://booking.oneplace.com.tw'};
    assert.equal((await post('/line-session',{idToken:'one.other.three'},origin)).status,403);
    const login=await post('/line-session',{idToken:'one.two.three'},origin);
    assert.equal(login.status,204);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    assert.match(cookie,/^__Host-booking_line=[0-9a-f]{64}$/);
    const headers={Cookie:cookie+'; unrelated=private'};
    assert.equal((await fetch(url+'/principal',{headers})).headers.get('X-Booking-Subject'),uid);
    for(const path of ['/api/send-otp','/api/verify-otp','/api/submit']) assert.equal((await post(path,{},headers)).status,200);
    const receipt='/api/submissions/12345678-1234-4123-8123-123456789abc';
    assert.equal((await fetch(url+receipt,{headers})).status,401);
    assert.equal((await fetch(url+receipt,{headers:{...headers,Authorization:'Bearer '+'a'.repeat(64)}})).status,200);
    assert.equal((await post('/api/send-sms',{},headers)).status,404);
    assert.equal(calls.length,4);
    console.log('PASS owner session, wrong origin / LINE identity, four scoped requests, receipt auth, SMS admin denial');
  } catch(error) {console.error(error); process.exitCode=1;} finally {server.close();}
});
