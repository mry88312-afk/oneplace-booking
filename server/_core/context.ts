import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";

/**
 * 預約服務的 tRPC context。
 * - 租客端 procedures 為 publicProcedure（不需認證）
 * - 後台 procedures 為 adminProcedure（靠 x-admin-password header 比對 env）
 */
export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: null;
  /** 前端後台請求帶的密碼（x-admin-password header），供 adminProcedure 驗證 */
  adminPassword: string | null;
};

export async function createContext(opts: CreateExpressContextOptions): Promise<TrpcContext> {
  const raw = opts.req.headers["x-admin-password"];
  const adminPassword = Array.isArray(raw) ? raw[0] : raw || null;
  return {
    req: opts.req,
    res: opts.res,
    user: null,
    adminPassword,
  };
}
