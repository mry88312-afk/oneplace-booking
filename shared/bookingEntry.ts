export const CONTRACT_ENTRY_CLOSED = '此續約入口已停止接受新預約，請使用線上續約入口。既有預約仍可從原確認卡改期或取消。';

export function acceptsNewBookings(projectId: string): boolean {
  return projectId !== 'contract';
}

export function bookingCardAction(params: URLSearchParams): { action: 'reschedule' | 'cancel'; bookingId: number } | null {
  const action = params.has('reschedule') ? 'reschedule' : params.has('cancel') ? 'cancel' : null;
  if (!action) return null;
  const value = params.get(action) || '';
  const bookingId = Number(value);
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(bookingId) ? { action, bookingId } : null;
}

/** Login must keep the card action and dataset, including old contract URLs. */
export function bookingLoginRedirect(origin: string, projectId: string, params: URLSearchParams): string {
  const url = new URL(`/book/${projectId === 'contract' ? 'renewal' : projectId}`, origin);
  const card = bookingCardAction(params);
  if (card) {
    url.searchParams.set(card.action, String(card.bookingId));
    const dataset = params.get('dataset');
    if (dataset) url.searchParams.set('dataset', dataset);
  } else {
    const t = params.get('t') || '';
    if (/^(\d{8}|\d{12})$/.test(t)) url.searchParams.set('t', t);
  }
  return url.toString();
}

/** LIFF may deliver card actions directly or inside an encoded liff.state URL. */
export function bookingEntryParams(search: string): URLSearchParams {
  const params = new URLSearchParams(search);
  let state = params.get('liff.state');
  if (!state) return params;
  try {
    if (state.startsWith('%')) state = decodeURIComponent(state);
    const nested = new URL(state, 'https://booking.invalid').searchParams;
    for (const [key, value] of nested) if (!params.has(key)) params.set(key, value);
  } catch { /* Keep direct parameters; malformed state must not unlock a new entry. */ }
  return params;
}
