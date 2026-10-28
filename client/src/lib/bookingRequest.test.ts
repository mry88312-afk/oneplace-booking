import assert from "node:assert/strict";
import test from "node:test";
import { bookingRequest, confirmBookingRequest } from "./bookingRequest";

test("errors, changed time and page reload reuse a request; a confirmed new slot gets a new request", () => {
  const items = new Map<string, string>();
  const storage = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); } };
  let ids = 0;
  const newId = () => `00000000-0000-0000-0000-${String(++ids).padStart(12, "0")}`;
  const first = bookingRequest(storage, "tenant-room", "18:00", newId);
  assert.deepEqual(bookingRequest(storage, "tenant-room", "18:00", newId), first);
  assert.deepEqual(bookingRequest(storage, "tenant-room", "20:00", newId), first);
  assert.deepEqual(bookingRequest(storage, "tenant-room", "18:00", newId), first);
  confirmBookingRequest(storage, first.storageKey, first.requestId);
  assert.deepEqual(bookingRequest(storage, "tenant-room", "18:00", newId), first);
  assert.notEqual(bookingRequest(storage, "tenant-room", "20:00", newId).requestId, first.requestId);
  assert.notEqual(bookingRequest(storage, "different-room", "20:00", newId).requestId, first.requestId);
});

test("unavailable browser storage fails closed before an untracked submission", () => {
  assert.throws(() => bookingRequest({ getItem: () => { throw new Error("blocked"); }, setItem: () => {} }, "tenant", "slot"), /blocked/);
});
