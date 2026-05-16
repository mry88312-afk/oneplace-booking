import { trpc } from "@/lib/trpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import "./index.css";
import { FontSizeProvider } from "./contexts/FontSizeContext";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,
      gcTime: 10 * 60 * 1000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

queryClient.getQueryCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "error") {
    console.error("[API Query Error]", event.query.state.error);
  }
});

queryClient.getMutationCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "error") {
    console.error("[API Mutation Error]", event.mutation.state.error);
  }
});

/**
 * 包裝 fetch：放行 rate limit 或非 JSON response 時，轉為友善的 JSON 錯誤
 * 避免 tRPC 內部 JSON.parse 對純文字如 "Rate exceeded." 拋出異常
 * 並對 5xx/rate-limit 自動重試（指數退避，最多 2 次）
 */
async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let resp: Response;
  try {
    resp = await globalThis.fetch(input, {
      ...(init ?? {}),
      credentials: "include",
    });
  } catch (networkError) {
    console.warn("[tRPC-fetch] 網路錯誤:", networkError);
    const errorBody = JSON.stringify([
      {
        error: {
          message: "網路連線失敗，請檢查網路後重試",
          code: -32603,
          data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 503, path: "" },
        },
      },
    ]);
    return new Response(errorBody, {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  const text = await resp.text();
  const ct = resp.headers.get("content-type") || "";

  if (ct.includes("application/json")) {
    try {
      JSON.parse(text);
      return new Response(text, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      });
    } catch {
      console.warn("[tRPC-fetch] Content-Type 為 JSON 但內容無效:", text.substring(0, 100));
    }
  }

  const isRateLimit = resp.status === 429 || text.toLowerCase().includes("rate");
  const errorMessage = isRateLimit
    ? "請求過於頻繁，請稍後再試"
    : `伺服器暫時無法回應 (${resp.status})`;
  console.warn("[tRPC-fetch] 非 JSON response:", resp.status, text.substring(0, 100));

  const retryCount = (init as any)?._retryCount ?? 0;
  const isServerError = resp.status >= 500 && resp.status < 600;
  if ((isRateLimit || isServerError) && retryCount < 2) {
    const delay = Math.min(2000 * Math.pow(2, retryCount), 8000);
    console.log(
      `[tRPC-fetch] ${isRateLimit ? "Rate limit" : "Server error"} detected, retrying after ${delay}ms (attempt ${retryCount + 1}/2)...`,
    );
    await new Promise((r) => setTimeout(r, delay));
    return safeFetch(input, { ...(init ?? {}), _retryCount: retryCount + 1 } as any);
  }

  const errorBody = JSON.stringify([
    {
      error: {
        message: errorMessage,
        code: isRateLimit ? -32029 : -32603,
        data: {
          code: isRateLimit ? "TOO_MANY_REQUESTS" : "INTERNAL_SERVER_ERROR",
          httpStatus: resp.status,
          path: "",
        },
      },
    },
  ]);
  return new Response(errorBody, {
    status: resp.status,
    headers: { "content-type": "application/json" },
  });
}

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      methodOverride: "POST",
      fetch: safeFetch,
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <FontSizeProvider>
        <App />
      </FontSizeProvider>
    </QueryClientProvider>
  </trpc.Provider>,
);
