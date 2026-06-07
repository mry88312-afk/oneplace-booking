import { router } from "../_core/trpc";
import { bookingRouter } from "./property/booking";
import { outreachRouter } from "./property/outreachHandlers";

export const appRouter = router({
  booking: bookingRouter,
  outreach: outreachRouter,
});

export type AppRouter = typeof appRouter;
