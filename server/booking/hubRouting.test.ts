import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyHub, notifyPath, parseRoute, postToHub, relayPath } from "./hubRouting";

test("route is local and restricted to a company HTTPS origin", () => {
  for (const origin of ["http://s.oneplace.com.tw","https://evil.com","https://a.oneplace.com.tw.evil.com","https://a.oneplace.com.tw/x","https://user@a.oneplace.com.tw","https://a.oneplace.com.tw:8080"])
    assert.throws(() => parseRoute(JSON.stringify({primary:"gcp",origin})));
});
test("both endpoints choose one site BEFORE exposing the actual card", async t => {
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
  for (const path of [relayPath, notifyPath] as const) {
    for (const mode of ["zeabur","gcp","badProbe","probeTimeout","postTimeout","post502","postNoReceipt","rollback","brokenConfig"]) {
      const primary = mode === "zeabur" || mode === "rollback" ? "zeabur" : "gcp";
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
        return Response.json(mode === "postNoReceipt" ? {} : {sentMessages:[{id:"abc"}]});
      });
      try {
        const result = await postToHub(path, {fixture:"card"}, {requireMessageId:true});
        assert.equal(result.ok,!["postTimeout","post502","postNoReceipt","brokenConfig"].includes(mode),mode);
        assert.deepEqual(probes, primary==="gcp" && mode!=="brokenConfig" ? [gcp+path] : [], mode);
        assert.deepEqual(sends,mode==="brokenConfig"?[]:[(["zeabur","badProbe","probeTimeout","rollback"].includes(mode)?legacyHub:gcp)+path],mode);
      } finally { f.mock.restore(); }
    }
  }
});
