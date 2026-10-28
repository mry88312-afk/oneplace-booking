import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "./trpc";
import { createContext } from "./context";
import { BOOKING_UNAVAILABLE } from "../../shared/bookingErrors";

test("the actual tRPC HTTP response hides SQL, uploaded bytes and stack, while retaining actionable validation", async t => {
  const app = express();
  const testRouter = router({
    failed: publicProcedure.query(() => { throw new Error("Failed query insert into booking_records params: private-account,data:image/png;base64,private-photo"); }),
    invalid: publicProcedure.query(() => { throw new TRPCError({ code: "BAD_REQUEST", message: "請選擇預約時段" }); }),
  });
  app.use("/api/trpc", createExpressMiddleware({ router: testRouter, createContext }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const failed = await fetch(`http://127.0.0.1:${address.port}/api/trpc/failed`);
  const body = await failed.text();
  assert.equal(failed.status, 500);
  assert.ok(body.includes(BOOKING_UNAVAILABLE));
  for (const secret of ["private-account", "private-photo", "insert into", "params:", "stack"]) assert.ok(!body.includes(secret), secret);
  const invalid = await fetch(`http://127.0.0.1:${address.port}/api/trpc/invalid`);
  assert.equal(invalid.status, 400);
  assert.ok((await invalid.text()).includes("請選擇預約時段"));
});
