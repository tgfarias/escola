/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { SASS_SILENCED } from "./build/sass.ts";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "App Lanche",
        short_name: "Lanche",
        lang: "pt-BR",
        start_url: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#0f766e",
      },
      workbox: { navigateFallbackDenylist: [/^\/api\//] },
    }),
  ],
  css: { preprocessorOptions: { scss: { quietDeps: true, silenceDeprecations: SASS_SILENCED } } },
  server: { proxy: { "/api": "http://localhost:8080" } },
  test: { environment: "jsdom" },
});
