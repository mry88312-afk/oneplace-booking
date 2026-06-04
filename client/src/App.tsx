import { Toaster } from "@/components/ui/sonner";
import { Route, Switch } from "wouter";
import { Suspense, lazy } from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { Loader2 } from "lucide-react";

const BookingPublic = lazy(() => import("./pages/BookingPublic"));
const AdminGate = lazy(() => import("./pages/AdminGate"));

function PageLoadingFallback() {
  return (
    <div className="flex items-center justify-center h-screen">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

function BookingNotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 text-center">
      <h1 className="text-2xl font-semibold mb-2">找不到預約專案</h1>
      <p className="text-muted-foreground">請確認您的預約連結是否正確，或聯絡客服。</p>
    </div>
  );
}

function Router() {
  return (
    <Suspense fallback={<PageLoadingFallback />}>
      <Switch>
        <Route path="/admin" component={AdminGate} />
        <Route path="/book/:projectId" component={BookingPublic} />
        <Route path="/book">{() => <BookingNotFound />}</Route>
        <Route>{() => <BookingNotFound />}</Route>
      </Switch>
    </Suspense>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <Toaster />
        <Router />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
