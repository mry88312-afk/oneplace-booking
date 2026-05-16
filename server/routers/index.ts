import { router } from "../_core/trpc";
import { bookingRouter } from "./property/booking";

export const appRouter = router({
  booking: bookingRouter,
});

export type AppRouter = typeof appRouter;
