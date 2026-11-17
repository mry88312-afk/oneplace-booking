export type TrackingFailure = 'login_failed'|'identity_failed'|'load_failed'|'slots_failed'|'no_slots'|'submit_failed'|'upload_failed'|'remittance_failed';
declare global {
  interface Window { OnePlaceTracking?: {error:(code:TrackingFailure)=>void;retry:(code:TrackingFailure)=>void}; __ltPending?: {kind:'error'|'retry';code:TrackingFailure}[] }
}
// 只傳固定分類；不傳表單、帳號、錯誤原文或租客資料。追蹤故障不得影響預約。
export function reportBookingFailure(code:TrackingFailure,retry=false) {
  try {
    const kind=retry?'retry':'error';
    if(window.OnePlaceTracking)window.OnePlaceTracking[kind](code);
    else {const queue=window.__ltPending??(window.__ltPending=[]);if(queue.length<20)queue.push({kind,code});}
  } catch {}
}
