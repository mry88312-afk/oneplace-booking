// 統一 Node.js 時區為 UTC，確保 Date 物件與 MySQL UTC 一致
process.env.TZ = "UTC";

import "dotenv/config";
import express from "express";
import compression from "compression";
import crypto from "node:crypto";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const server = createServer(app);

  // 壓縮 API 回應
  app.use(compression());

  // tRPC body parser：confirmBooking 把檔案以 base64 data URL 一起送進來
  // （取代原 /api/upload 中間站，避免 Zeabur 端要維護額外的存檔端點 / 不繞 MANUS）
  // 25 MB 足夠存摺照片、收據等場景；前端會先壓縮圖片才送
  app.use("/api/trpc", express.json({ limit: "25mb" }));
  app.use("/api/trpc", express.urlencoded({ limit: "25mb", extended: true }));

  // 其他路由：標準 1MB
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  // 健康檢查（Zeabur 用）
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, service: "oneplace-booking", ts: Date.now() });
  });

  // tRPC
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      allowMethodOverride: true,
      onError: ({ error, path }) => {
        if (error.code === "INTERNAL_SERVER_ERROR") {
          console.error(`[tRPC] Internal error on ${path}:`, error.message);
        }
      },
    }),
  );

  // 週期詢問：Supabase pg_cron 透過 pg_net 呼叫此端點，派送「到期且已確認」的卡片。
  // 需帶共享密鑰 header（x-outreach-secret 必須等於環境變數 OUTREACH_RUN_SECRET）。
  app.post("/api/outreach/run", async (req, res) => {
    const expected = process.env.OUTREACH_RUN_SECRET;
    if (!expected) {
      return res.status(503).json({ error: "OUTREACH_RUN_SECRET not set" });
    }
    const got = String(req.header("x-outreach-secret") || "");
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const ids = Array.isArray(req.body?.schedule_ids) ? req.body.schedule_ids : [];
    try {
      const { runOutreach } = await import("./routers/property/outreachHandlers");
      const result = await runOutreach(ids);
      console.log(`[outreach] run for ${ids.length} ids → ${JSON.stringify(result)}`);
      return res.json({ ok: true, result });
    } catch (err: any) {
      console.error("[outreach] run error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "error" });
    }
  });

  // 測試發送：把貼上的卡片推到指定 uid（從 Zeabur 發送，可預覽卡片實際樣子）。需共享密鑰。
  app.post("/api/outreach/test-send", async (req, res) => {
    const expected = process.env.OUTREACH_RUN_SECRET;
    if (!expected) return res.status(503).json({ error: "OUTREACH_RUN_SECRET not set" });
    const got = String(req.header("x-outreach-secret") || "");
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const { uid, card, altText, vars } = req.body || {};
    if (!uid || !card) return res.status(400).json({ error: "uid and card required" });
    try {
      const { pushTestCard } = await import("./routers/property/outreachHandlers");
      const r = await pushTestCard(uid, card, altText, vars);
      console.log(`[outreach] test-send to ${String(uid).slice(0, 8)}… → ${JSON.stringify(r)}`);
      return res.status(r.success ? 200 : 400).json(r);
    } catch (err: any) {
      console.error("[outreach] test-send error:", err?.message || err);
      return res.status(500).json({ error: err?.message || "error" });
    }
  });

  // 靜態檔案（前端 build 後的 SPA）
  if (process.env.NODE_ENV === "production") {
    const clientDist = path.resolve(__dirname, "public");
    app.use(express.static(clientDist));
    // SPA fallback — 所有非 API 路徑都回 index.html，讓 wouter 接管路由
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  const port = parseInt(process.env.PORT || "3000");
  server.listen(port, () => {
    console.log(`[oneplace-booking] Server running on http://localhost:${port}/`);
    console.log(`[oneplace-booking] Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`[oneplace-booking] DATABASE_URL: ${process.env.DATABASE_URL ? "set" : "MISSING"}`);
    console.log(`[oneplace-booking] RAGIC_API_KEY: ${process.env.RAGIC_API_KEY ? "set" : "MISSING"}`);
    console.log(`[oneplace-booking] MAIN_SYSTEM_WEBHOOK_URL: ${process.env.MAIN_SYSTEM_WEBHOOK_URL ? "set" : "MISSING"}`);
    console.log(`[oneplace-booking] BOOKING_WEBHOOK_SECRET: ${process.env.BOOKING_WEBHOOK_SECRET ? "set" : "MISSING"}`);
    console.log(`[oneplace-booking] GOOGLE_SERVICE_ACCOUNT_JSON: ${process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? "set" : "MISSING"}`);
    if (!process.env.DATABASE_URL) {
      console.warn("[oneplace-booking] ⚠️  DATABASE_URL not set");
    }
    if (!process.env.MAIN_SYSTEM_WEBHOOK_URL) {
      console.warn(
        "[oneplace-booking] ⚠️  MAIN_SYSTEM_WEBHOOK_URL not set — LINE notify will be skipped",
      );
    }
  });
}

startServer().catch(console.error);

const shutdown = async () => {
  console.log("[oneplace-booking] Closing database pool...");
  const { closeDb } = await import("./db");
  await closeDb();
  const { closeSupabasePool } = await import("./db/supabaseClient");
  await closeSupabasePool();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
