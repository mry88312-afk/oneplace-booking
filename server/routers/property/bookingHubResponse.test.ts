import assert from "node:assert/strict";
import test from "node:test";
import { postToHub } from "./bookingConfirmHandler";

for (const scenario of [
  { name: "LINE sentMessages acknowledgement", body: JSON.stringify({ sentMessages: [{ id: "test-message" }] }), ok: true },
  { name: "legacy LINE empty JSON acknowledgement", body: "{}", ok: true },
  { name: "HTTP 200 missing_fields is a failed delivery", body: JSON.stringify({ error: "missing_fields", required: ["recordUid"] }), ok: false },
  { name: "HTTP 200 explicit failure", body: JSON.stringify({ success: false }), ok: false },
  { name: "HTTP 200 HTML proxy response", body: "<html>Unavailable</html>", ok: false },
  { name: "HTTP 200 null response", body: "null", ok: false },
]) {
  test(scenario.name, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response(scenario.body, { status: 200 });
    });
    const result = await postToHub("https://example.invalid/api/line/relay", {});
    assert.equal(result.ok, scenario.ok);
    assert.equal(calls, 1, "do not retry an ambiguous or rejected HTTP 200 response");
    if (!scenario.ok) assert.ok(result.error);
  });
}
