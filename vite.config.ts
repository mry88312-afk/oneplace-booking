import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: path.resolve(__dirname, "client"),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client/src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-liff": ["@line/liff"],
          "vendor-react": ["react", "react-dom"],
          "vendor-radix": [
            "@radix-ui/react-label",
            "@radix-ui/react-select",
            "@radix-ui/react-slot",
          ],
          "vendor-data": ["@tanstack/react-query", "@trpc/client", "@trpc/react-query"],
          "vendor-utils": ["date-fns", "superjson"],
          "vendor-icons": ["lucide-react"],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // 本機 API 轉發目標；可用 API_PROXY 覆寫（避免與其他專案搶 3000）。預設 3000。
      "/api": process.env.API_PROXY || "http://localhost:3000",
    },
  },
});
