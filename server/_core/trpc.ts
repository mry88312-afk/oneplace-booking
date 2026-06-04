import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
// 公開預約服務的 procedures（租客端，不需 auth）
export const publicProcedure = t.procedure;

/**
 * 後台 admin middleware：比對請求 header 的密碼與環境變數 ADMIN_PASSWORD。
 * - ADMIN_PASSWORD 未設定 → 一律拒絕（避免誤開無密碼後台）
 * - 密碼不符 → UNAUTHORIZED
 */
const requireAdmin = t.middleware(({ ctx, next }) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "後台未啟用（ADMIN_PASSWORD 未設定）",
    });
  }
  if (!ctx.adminPassword || ctx.adminPassword !== expected) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "密碼錯誤" });
  }
  return next();
});

/** 後台專用 procedure，需帶正確的 x-admin-password */
export const adminProcedure = t.procedure.use(requireAdmin);
