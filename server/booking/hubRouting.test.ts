import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFieldopsInboxUrl } from "../../shared/fieldops";
import { notifyPath, parseRoute, postToHub, relayPath, roommateGroupNotifyPath } from "./hubRouting";

test("客服聊天連結接受新舊網域，且須含有效 UID", () => {
  const uid = "U" + "a".repeat(32);
  assert.ok(isFieldopsInboxUrl(`https://fieldops.oneplace.com.tw/inbox?uid=${uid}`));
  assert.ok(isFieldopsInboxUrl(`https://fieldops.zeabur.app/inbox?uid=${uid}`));
  assert.equal(isFieldopsInboxUrl(`https://fieldops.oneplace.com.tw.example.org/inbox?uid=${uid}`), false);
  assert.equal(isFieldopsInboxUrl("https://fieldops.oneplace.com.tw/inbox?uid=invalid"), false);
});

test("route is local and restricted to a company HTTPS origin", () => {
  for (const origin of ["http://s.oneplace.com.tw","https://evil.com","https://a.oneplace.com.tw.evil.com","https://a.oneplace.com.tw/x","https://user@a.oneplace.com.tw","https://a.oneplace.com.tw:8080"])
    assert.throws(() => parseRoute(JSON.stringify({primary:"gcp",origin})));
});
test("all endpoints choose one site BEFORE exposing the actual card", async t => {
  const folder = mkdtempSync(join(tmpdir(), "hub-test-"));
  const file = join(folder, "route.json");
  const old = { secret: process.env.BOOKING_WEBHOOK_SECRET, file: process.env.BOOKING_HUB_ROUTE_FILE };
  process.env.BOOKING_HUB_ROUTE_FILE = file;
  process.env.BOOKING_WEBHOOK_SECRET = "fixture-only";
  t.after(() => {
    for (const [k,v] of Object.entries({BOOKING_WEBHOOK_SECRET:old.secret,BOOKING_HUB_ROUTE_FILE:old.file}))
      if (v === undefined) delete process.env[k]; else process.env[k]=v;
    rmSync(folder,{recursive:true});
  });
  const gcp = "https://fixture.oneplace.com.tw";
  const fieldops = "https://fieldops.oneplace.com.tw";
  for (const path of [relayPath, notifyPath, roommateGroupNotifyPath] as const) {
    for (const mode of ["default","zeabur","gcp","badProbe","probeTimeout","postTimeout","post502","postNoReceipt","rollback","brokenConfig"]) {
      const primary = ["default", "zeabur", "rollback"].includes(mode) ? "zeabur" : "gcp";
      if (mode === "default") delete process.env.BOOKING_HUB_ROUTE_FILE;
      else process.env.BOOKING_HUB_ROUTE_FILE = file;
      writeFileSync(file, mode === "brokenConfig" ? "{" : JSON.stringify({primary,origin:gcp}));
      const sends: string[] = [], probes: string[] = [];
      const f = t.mock.method(globalThis,"fetch",async (url,init) => {
        assert.equal(init?.redirect, "error");
        if (init?.body === "{}") {
          probes.push(String(url)); assert.equal(String(url),gcp+path);
          if (mode === "probeTimeout") throw Error("probe timeout");
          if (mode === "badProbe") return new Response("unavailable",{status:502});
          return Response.json({error:"missing_fields",required:path===relayPath?["lineEndpoint","payload"]:["tenantUid","flexMessage"]},{status:400});
        }
        sends.push(String(url));
        if (mode === "postTimeout") throw Error("accepted then disconnected");
        if (mode === "post502") return new Response("unavailable",{status:502});
        if (mode === "postNoReceipt") return Response.json({});
        return Response.json(path === roommateGroupNotifyPath
          ? { ok: true, status: "sent" }
          : { sentMessages: [{ id: "abc" }] });
      });
      try {
        const result = await postToHub(path, {fixture:"card"}, {requireMessageId:true});
        assert.equal(result.ok,!["postTimeout","post502","postNoReceipt","brokenConfig"].includes(mode),mode);
        assert.deepEqual(probes, primary==="gcp" && mode!=="brokenConfig" ? [gcp+path] : [], mode);
        assert.deepEqual(sends,mode==="brokenConfig"?[]:[(["default","zeabur","badProbe","probeTimeout","rollback"].includes(mode)?fieldops:gcp)+path],mode);
      } finally { f.mock.restore(); }
    }
  }
});
