import assert from "node:assert/strict";
import test from "node:test";
import mysql from "mysql2/promise";
import { closeDb, getDb, isDatabaseHealthy } from "./connection";

test("lazy mysql pool creation is not treated as healthy until a query succeeds", async t => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "mysql://fixture:fixture@127.0.0.1/fixture";
  t.after(async () => { await closeDb(); if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  let ended = 0;
  const logs: unknown[] = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  t.mock.method(console, "log", (...args) => logs.push(args));
  t.mock.method(console, "warn", () => {});
  t.mock.method(mysql, "createPool", () => ({
    query: async () => { throw Object.assign(new Error("Access denied for user private-user"), { code: "ER_ACCESS_DENIED_ERROR" }); },
    end: async () => { ended++; },
  }));
  assert.equal(await getDb(), null);
  assert.equal(isDatabaseHealthy(), false);
  assert.equal(ended, 2, "failed candidate pools are closed");
  assert.ok(!JSON.stringify(logs).includes("private-user"));
  assert.ok(!JSON.stringify(logs).includes("rebuilt successfully"));
  let externalCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { externalCalls++; throw new Error("unexpected external request"); });
  const { handleConfirmBooking } = await import("../routers/property/bookingConfirmHandler");
  await assert.rejects(handleConfirmBooking({
    requestId: "00000000-0000-0000-0000-000000000001",
    projectId: "checkout", uid: "fixture-user", tenantName: "fixture", roomNumber: "TEST",
    date: "2026-10-31", startTime: "2026-10-31T10:00:00Z", endTime: "2026-10-31T11:00:00Z",
    calendarId: "fixture-calendar", assigneeName: "fixture",
  }, { req: { ip: "fixture-ip" } }), { code: "SERVICE_UNAVAILABLE" });
  assert.equal(externalCalls, 0, "the actual handler must stop before Ragic or notifications");
});
