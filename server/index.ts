// 統一 Node.js 時區為 UTC，確保 Date 物件與 MySQL UTC 一致
process.env.TZ = "UTC";

import "dotenv/config";
import express from "express";
import compression from "compression";
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

  // tRPC body parser：預約有檔案上傳（base64），需要較大 limit
  app.use("/api/trpc", express.json({ limit: "10mb" }));
  app.use("/api/trpc", express.urlencoded({ limit: "10mb", extended: true }));

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
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
