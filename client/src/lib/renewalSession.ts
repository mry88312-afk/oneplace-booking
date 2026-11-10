/// <reference types="vite/client" />
import liff from '@line/liff';

export const usesBookingSession = import.meta.env.VITE_REMITTANCE_API_BASE === '/booking-link';
let pending: Promise<void> | undefined;
let validUntil = 0;
let lastUid: string | undefined;

export async function ensureBookingSession() {
  if (!usesBookingSession) return;
  const uid = liff.getDecodedIDToken()?.sub || undefined;
  if (uid && uid === lastUid && Date.now() < validUntil) return;
  if (!pending) {
    pending = (async () => {
      const response = await fetch('/booking-link/line-session', {
        method: 'POST', credentials: 'same-origin', referrerPolicy: 'strict-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: liff.getIDToken(), accessToken: liff.getAccessToken() }),
      });
      if (!response.ok) throw new Error('請從受邀的 LINE 帳號重新開啟預約連結。');
      lastUid = uid;
      validUntil = Date.now() + 5 * 60_000;
    })().finally(() => { pending = undefined; });
  }
  await pending;
}
