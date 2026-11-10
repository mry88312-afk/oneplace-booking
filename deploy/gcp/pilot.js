'use strict';
const liffId = 'PILOT_LIFF';
for (const project of ['renewal','checkout']) {
  document.getElementById(project).href = 'https://liff.line.me/' + liffId + '/book/' + project;
}
(async () => {
  await liff.init({liffId});
  if (location.pathname === '/') document.getElementById('status').textContent = '請選擇要驗收的流程。';
})().catch(() => { document.getElementById('status').textContent = '請從 LINE 重新開啟預約驗收連結。'; });
