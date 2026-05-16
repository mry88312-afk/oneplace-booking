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
      "/api": "http://localhost:3000",
    },
  },
});
