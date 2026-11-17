import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { bookingRouter } from '../routers/property/booking';
import { reportBookingFailure } from '../../client/src/lib/bookingTracking';

test('租客歷程必須通過管理員驗證，只有參照碼不能查詢',async t=>{
  const prior=process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD='隔離測試密碼';
  t.after(()=>{if(prior===undefined)delete process.env.ADMIN_PASSWORD;else process.env.ADMIN_PASSWORD=prior;});
  const ctx={req:{headers:{}} as Request,res:{} as Response,user:null,adminPassword:null};
  await assert.rejects(bookingRouter.createCaller(ctx).journeyTenant({reference:'12345678-1234-4234-a234-123456789abc'}),e=>e instanceof Error && 'code' in e && e.code==='UNAUTHORIZED');
  await assert.rejects(bookingRouter.createCaller({...ctx,adminPassword:'隔離測試密碼'}).journeyTenant({reference:'不是有效參照'}),e=>e instanceof Error && 'code' in e && e.code==='BAD_REQUEST');
});

test('建立對應不接受未驗證 LINE 的請求',async t=>{
  const prior=process.env.BOOKING_REMITTANCE_BRIDGE;
  process.env.BOOKING_REMITTANCE_BRIDGE='http://unused.invalid';
  t.after(()=>{if(prior===undefined)delete process.env.BOOKING_REMITTANCE_BRIDGE;else process.env.BOOKING_REMITTANCE_BRIDGE=prior;});
  const caller=bookingRouter.createCaller({req:{headers:{}} as Request,res:{} as Response,user:null,adminPassword:null});
  await assert.rejects(caller.linkJourney(),e=>e instanceof Error && 'code' in e && e.code==='UNAUTHORIZED');
});

test('追蹤尚未載入時限量暫存，追蹤故障不能中斷預約',t=>{
  const prior=Object.getOwnPropertyDescriptor(globalThis,'window');
  const fake:Pick<Window,'OnePlaceTracking'|'__ltPending'>={};
  Object.defineProperty(globalThis,'window',{value:fake,configurable:true});
  t.after(()=>{if(prior)Object.defineProperty(globalThis,'window',prior);else Reflect.deleteProperty(globalThis,'window');});
  for(let i=0;i<25;i++)reportBookingFailure('login_failed');
  assert.equal(fake.__ltPending?.length,20);
  assert.deepEqual(fake.__ltPending?.[0],{kind:'error',code:'login_failed'});
  fake.OnePlaceTracking={error:()=>{throw new Error('追蹤不可用');},retry:()=>{throw new Error('追蹤不可用');}};
  assert.doesNotThrow(()=>reportBookingFailure('submit_failed'));
  assert.doesNotThrow(()=>reportBookingFailure('identity_failed',true));
});
