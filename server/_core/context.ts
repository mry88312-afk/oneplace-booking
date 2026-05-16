import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";

/**
 * 公開預約服務的 tRPC context — 極簡版本
 * 不做認證，因為所有 procedures 都是 publicProcedure
 */
export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: null;
};

export async function createContext(opts: CreateExpressContextOptions): Promise<TrpcContext> {
  return {
    req: opts.req,
    res: opts.res,
    user: null,
  };
}
