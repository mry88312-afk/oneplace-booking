import assert from "node:assert/strict";
import test from "node:test";
import { ragicUploadFile, ragicPost } from "./bookingHelpers";

for (const scenario of [
  { name: "uploaded filename receipt", body: '{"123":"opaque@upload.png"}', status: 200, accepted: true },
  { name: "explicit success receipt", body: '{"status":"SUCCESS","ragicId":42}', status: 200, accepted: true },
  { name: "HTTP 200 application rejection", body: '{"status":"ERROR","msg":"private form data"}', status: 200, accepted: false },
  { name: "HTTP 200 invalid fields", body: '{"status":"INVALID"}', status: 200, accepted: false },
  { name: "HTTP 200 without receipt", body: '{}', status: 200, accepted: false },
  { name: "HTTP 200 HTML proxy response", body: '<html>private form data</html>', status: 200, accepted: false },
  { name: "HTTP 500", body: 'private form data', status: 500, accepted: false },
]) {
  test(`attachment ${scenario.name}`, async t => {
    let calls = 0;
    const logs: unknown[] = [];
    t.mock.method(console, "error", (...args) => logs.push(args));
    t.mock.method(console, "log", (...args) => logs.push(args));
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(scenario.body, { status: scenario.status }); });
    const upload = ragicUploadFile("fixture/1", 42, "123", "data:image/png;base64,aGVsbG8=");
    if (scenario.accepted) await upload;
    else await assert.rejects(upload, /not confirmed/);
    assert.equal(calls, 1, "an ambiguous upload must not automatically retry");
    assert.ok(!JSON.stringify(logs).includes("private form data"));
  });
}

test("Ragic create rejects an HTTP 200 validation error without logging the form or upstream body", async t => {
  const logs: unknown[] = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  t.mock.method(console, "log", (...args) => logs.push(args));
  t.mock.method(globalThis, "fetch", async () => new Response('{"status":"INVALID","msg":"private-account"}'));
  await assert.rejects(ragicPost("fixture/1", { account: "private-account" }), /rejected/);
  assert.ok(!JSON.stringify(logs).includes("private-account"));
});
