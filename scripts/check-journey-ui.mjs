// 僅供本機隔離假資料畫面驗證，不接正式 API，不建立真實登入。
import express from 'express';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
const {chromium}=createRequire(process.env.ONEPLACE_BROWSER_PACKAGE||import.meta.url)('playwright');
const app=express();app.use(express.static('dist/public'));app.get('*',(_req,res)=>res.sendFile(process.cwd()+'/dist/public/index.html'));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));let browser;
try {
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/trpc/**',async route=>{
    const req=route.request(),names=new URL(req.url()).pathname.split('/').at(-1).split(',');
    const reply=names.map(name=>({result:{data:{json:name==='booking.journeyTenant'?[{name:'測試租客',property:'測試案場',room:'A101',end_date:'2027-01-31'}]:'test@example.invalid'}}}));
    if(names.includes('booking.journeyTenant'))assert.equal(req.headers()['x-admin-password'],'fixture-journey');
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(reply)});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/admin?journey=12345678-1234-4234-a234-123456789abc`);
  await page.getByText('預約後台登入',{exact:true}).waitFor();assert.equal(await page.getByText('測試租客',{exact:true}).count(),0);
  await page.locator('input[type=password]').fill('fixture-journey');await page.getByRole('button',{name:'登入',exact:true}).click();
  await page.getByText('測試租客',{exact:true}).waitFor();await page.getByText('測試案場 · A101',{exact:true}).waitFor();
  fs.mkdirSync('.artifacts',{recursive:true});await page.screenshot({path:'.artifacts/ONE-897-tenant-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'.artifacts/ONE-897-tenant-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('BOOKING 租客頁：登入閘門、租客及合約顯示、桌機與手機版通過（隔離假資料）。');
} finally {if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
