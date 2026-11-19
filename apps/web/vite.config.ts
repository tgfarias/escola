/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { guardianCssGuard } from "./build/guardianCss.ts";
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
        // $primary de src/theme/_brand.scss (o manifesto não lê SCSS).
        theme_color: "#047c37",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        // O tablet abre offline: fontes de ícone, CSS do tema, logo e ícones entram no precache.
        globPatterns: ["**/*.{js,css,html,woff,woff2,ttf,svg,png,jpg}"],
      },
    }),
    guardianCssGuard(),
  ],
  css: { preprocessorOptions: { scss: { quietDeps: true, silenceDeprecations: SASS_SILENCED } } },
  server: { proxy: { "/api": "http://localhost:8080" } },
  test: { environment: "jsdom" },
});
