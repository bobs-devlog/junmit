import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "esnext",
  },
  css: {
    modules: {
      // .module.css의 클래스명을 자동으로 camelCase로 변환 → styles.msEvent 형태로 접근
      localsConvention: "camelCaseOnly",
    },
  },
});
