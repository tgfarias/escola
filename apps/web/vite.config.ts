/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { guardianCssGuard } from "./build/guardianCss.ts";
import { SASS_SILENCED } from "./build/sass.ts";
import { themeScopePlugin } from "./build/themeScope.ts";

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
        // pe-icon-7-stroke.css lista eot, woff, ttf e svg nessa ordem: todo navegador com service worker usa o woff e
        // nunca pede os outros (cerca de 220 KB que cada celular baixaria à toa).
        globIgnores: ["**/node_modules/**", "**/Pe-icon-7-stroke-*.{ttf,svg,eot}"],
      },
    }),
    guardianCssGuard(),
  ],
  css: {
    // charset: false: sem "@charset" na frente, o comentário legal "/*!" de theme.scss abre a folha e o Lightning CSS o mantém.
    preprocessorOptions: { scss: { quietDeps: true, silenceDeprecations: SASS_SILENCED, charset: false } },
    // Todo seletor de theme.scss fica sob html.app-themed (build/themeScope.ts).
    postcss: { plugins: [themeScopePlugin()] },
  },
  server: { proxy: { "/api": "http://localhost:8080" } },
  test: { environment: "jsdom", setupFiles: ["./src/testSetup.ts"] },
});
