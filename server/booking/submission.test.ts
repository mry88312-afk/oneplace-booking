import assert from "node:assert/strict";
import test from "node:test";
import { submitBookingOnce, submissionIdentity, persistedAnswers, type SubmissionStore, type CompletedSubmission, type Reservation } from "./submission";
import { BOOKING_UNAVAILABLE, BOOKING_PENDING } from "../../shared/bookingErrors";

const completed: CompletedSubmission = { success: true, status: "confirmed", bookingId: 1, ragicRecordId: "42" };
const record = { templateId: 1, tenantUid: "fixture-user", bookingTime: 1793431200000, durationMinutes: 90 };
function fixture() {
  let reserved = false, done = false, hash = "", creates = 0, uploads = 0, saves = 0;
  const stages: string[] = [];
  const alerts: string[] = [];
  const store: SubmissionStore = {
    async reserve(_key, payloadHash): Promise<Reservation> {
      if (reserved && hash !== payloadHash) return { kind: "conflict" };
      if (done) return { kind: "completed", result: completed };
      if (reserved) return { kind: "pending" };
      reserved = true;
      hash = payloadHash;
      return { kind: "owner" };
    },
    async recordRagic() { stages.push("receipt"); },
    async complete() { saves++; done = true; return completed; },
    async markPending(_key, stage) { stages.push(stage); },
  };
  const options = {
    key: "request", payloadHash: "payload", store, record,
    createTask: async () => { creates++; return "42"; },
    uploadAttachments: async () => { uploads++; },
    onPending: async ({ stage }: { stage: string }) => { alerts.push(stage); },
  };
  return { store, options, stages, alerts, counts: () => ({ creates, uploads, saves }) };
}

test("simultaneous submissions and a later replay create only one external task and local booking", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 20 }, () => submitBookingOnce(f.options)));
  assert.equal(results.filter(r => r.success).length, 1);
  assert.equal(results.filter(r => !r.success).length, 19);
  assert.deepEqual(await submitBookingOnce(f.options), { ...completed, fresh: false });
  assert.deepEqual(f.counts(), { creates: 1, uploads: 1, saves: 1 });
  assert.deepEqual(f.alerts, []);
});

test("database authorization failure stops before any external write and returns no SQL parameters", async t => {
  const f = fixture();
  t.mock.method(console, "error", () => {});
  f.store.reserve = async () => { throw Object.assign(new Error("Failed query insert into bookings params: bank-account,data:image/png;base64,private"), { cause: { code: "ER_ACCESS_DENIED_ERROR" } }); };
  await assert.rejects(submitBookingOnce(f.options), { code: "SERVICE_UNAVAILABLE", message: BOOKING_UNAVAILABLE });
  assert.deepEqual(f.counts(), { creates: 0, uploads: 0, saves: 0 });
});

for (const [stage, fail] of [
  ["create_task", (f: ReturnType<typeof fixture>) => { f.options.createTask = async () => { throw new Error("timeout after remote commit"); }; }],
  ["save_receipt", (f: ReturnType<typeof fixture>) => { f.store.recordRagic = async () => { throw new Error("DB unavailable after external create"); }; }],
  ["upload_attachments", (f: ReturnType<typeof fixture>) => { f.options.uploadAttachments = async () => { throw new Error("upload rejected"); }; }],
  ["save_booking", (f: ReturnType<typeof fixture>) => { f.store.complete = async () => { throw new Error("booking insert failed"); }; }],
] as const) {
  test(`${stage} failure stays pending on every retry, with no success or second create`, async t => {
    const f = fixture();
    let externalAttempts = 0;
    const create = f.options.createTask;
    fail(f);
    const chosenCreate = stage === "create_task" ? f.options.createTask : create;
    f.options.createTask = async () => { externalAttempts++; return chosenCreate(); };
    t.mock.method(console, "error", () => {});
    assert.deepEqual(await submitBookingOnce(f.options), { success: false, status: "pending", message: BOOKING_PENDING });
    for (let i = 0; i < 3; i++) assert.equal((await submitBookingOnce(f.options)).success, false);
    assert.equal(externalAttempts, 1);
    assert.equal(f.counts().saves, 0);
    assert.ok(f.stages.includes(stage));
    assert.deepEqual(f.alerts, [stage]);
  });
}

test("lost COMMIT acknowledgement can be recovered by replay without duplicating the task", async t => {
  const f = fixture();
  const save = f.store.complete;
  f.store.complete = async (...args) => { await save(...args); throw new Error("lost commit response"); };
  t.mock.method(console, "error", () => {});
  assert.equal((await submitBookingOnce(f.options)).success, false);
  assert.deepEqual(await submitBookingOnce(f.options), { ...completed, fresh: false });
  assert.deepEqual(f.counts(), { creates: 1, uploads: 1, saves: 1 });
});

test("pending status and alert failure do not turn an ambiguous external write into a retry", async t => {
  const f = fixture();
  let attempts = 0;
  f.options.createTask = async () => { attempts++; throw new Error("timeout"); };
  f.store.markPending = async () => { throw new Error("DB offline"); };
  f.options.onPending = async () => { throw new Error("alert offline"); };
  t.mock.method(console, "error", () => {});
  assert.equal((await submitBookingOnce(f.options)).status, "pending");
  assert.equal((await submitBookingOnce(f.options)).status, "pending");
  assert.equal(attempts, 1);
});

test("missing Ragic receipt never becomes confirmed", async t => {
  const f = fixture();
  f.options.createTask = async () => "";
  t.mock.method(console, "error", () => {});
  assert.equal((await submitBookingOnce(f.options)).success, false);
  assert.equal(f.counts().uploads, 0);
  assert.equal(f.counts().saves, 0);
});

test("changing time or form answers on a reserved operation is rejected before writing again", async () => {
  const f = fixture();
  await submitBookingOnce(f.options);
  await assert.rejects(submitBookingOnce({ ...f.options, payloadHash: "changed" }), { code: "CONFLICT" });
  assert.equal(f.counts().creates, 1);
});

test("request hashing is order-stable, user-scoped and includes form answers", () => {
  const original = submissionIdentity("u1", "id", { a: 1, answers: { b: 2, a: 3 } });
  assert.deepEqual(original, submissionIdentity("u1", "id", { answers: { a: 3, b: 2 }, a: 1 }));
  assert.notEqual(original.key, submissionIdentity("u2", "id", {}).key);
  assert.notEqual(original.payloadHash, submissionIdentity("u1", "id", { a: 1, answers: { a: 3, b: 4 } }).payloadHash);
});

test("persisted answers retain ordinary values but exclude file bytes at every depth", () => {
  const answers = { name: "fixture", account: "fixture-account", photo: "data:image/png;base64,private", nested: ["data:image/jpeg;base64,private"] };
  const result = persistedAnswers(answers);
  assert.equal(result?.account, "fixture-account");
  assert.ok(!JSON.stringify(result).includes("base64"));
  assert.equal(answers.photo, "data:image/png;base64,private");
});
