import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@wailsio/runtime": fileURLToPath(new URL("./node_modules/@wailsio/runtime/dist/index.js", import.meta.url)),
    },
  },
});
