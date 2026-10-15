import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import bks from "@beekeeperstudio/vite-plugin";
import path from "node:path";

export default defineConfig({
  plugins: [vue(), bks()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    sourcemap: true,
  },
});
