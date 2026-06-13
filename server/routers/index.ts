import { router } from "../_core/trpc";
import { bookingRouter } from "./property/booking";
import { outreachRouter } from "./property/outreachHandlers";
import { messagingRouter } from "./property/messagingHandlers";

export const appRouter = router({
  booking: bookingRouter,
  outreach: outreachRouter,
  messaging: messagingRouter,
});

export type AppRouter = typeof appRouter;
