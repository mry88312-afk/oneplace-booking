import { initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
// 公開預約服務只暴露 public procedures（不需要 auth）
export const publicProcedure = t.procedure;
