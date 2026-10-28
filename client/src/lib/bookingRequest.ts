type RequestStorage = Pick<Storage, "getItem" | "setItem">;
type Receipt = { requestId: string; slot: string; confirmed: boolean };

/** Keep the same operation across errors, changed times and reopening this browser. */
export function bookingRequest(storage: RequestStorage, scope: string, slot: string, newId: () => string = () => crypto.randomUUID()) {
  const storageKey = `booking-request:v1:${scope}`;
  const raw = storage.getItem(storageKey);
  let receipt: Receipt | undefined;
  try { receipt = raw ? JSON.parse(raw) : undefined; } catch { /* invalid local entry */ }
  if (!receipt || !/^[a-f\d-]{36}$/i.test(receipt.requestId)
    || (receipt.confirmed && receipt.slot !== slot)) {
    receipt = { requestId: newId(), slot, confirmed: false };
  }
  receipt.slot = slot;
  storage.setItem(storageKey, JSON.stringify(receipt));
  return { storageKey, requestId: receipt.requestId };
}

export function confirmBookingRequest(storage: RequestStorage, storageKey: string, requestId: string) {
  const raw = storage.getItem(storageKey);
  if (!raw) return;
  const receipt: Receipt = JSON.parse(raw);
  if (receipt.requestId === requestId) storage.setItem(storageKey, JSON.stringify({ ...receipt, confirmed: true }));
}
