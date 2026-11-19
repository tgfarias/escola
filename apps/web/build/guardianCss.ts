import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

/** Marcadores do layout do tema: nenhum pode estar no CSS que index.html carrega (pacote dos responsáveis). */
export const THEME_MARKERS = [".app-sidebar", ".app-header", ".metismenu", ".kds-", "pe-7s-"];

/** Hrefs das folhas que index.html carrega de cara. */
export function entryStylesheets(html: string): string[] {
  return [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)]
    .map((m) => /\bhref="([^"]+)"/.exec(m[0])?.[1])
    .filter((href): href is string => href !== undefined);
}

/** Comentário legal ("/*!") do topo de theme.scss: o minificador o mantém, e o build confere. */
export const THEME_LICENSE_NOTICE = "ArchitectUI (MIT)";

/** Problemas: marcador do tema numa folha de entrada, tema sem o aviso de licença, ou tema ausente de todo o build. `cssFiles` usa caminhos relativos a dist. */
export function guardianCssProblems(html: string, cssFiles: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const href of entryStylesheets(html)) {
    const css = cssFiles[href.replace(/^\//, "")] ?? "";
    for (const marker of THEME_MARKERS) if (css.includes(marker)) problems.push(`${href} contém ${marker}`);
  }
  for (const [file, css] of Object.entries(cssFiles)) {
    if (css.includes(".app-sidebar") && !css.includes(THEME_LICENSE_NOTICE)) problems.push(`${file} perdeu o aviso de licença do ArchitectUI`);
  }
  if (!Object.values(cssFiles).some((css) => css.includes(".app-sidebar"))) problems.push("o CSS do tema não foi gerado");
  return problems;
}

/** Falha o build se o tema do admin/KDS vazar para o CSS inicial (spec 2026-11-19, "Carregamento"). */
export function guardianCssGuard(): Plugin {
  let outDir = "dist";
  return {
    name: "app-lanche:guardian-css-guard",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      const assets = join(outDir, "assets");
      const cssFiles = Object.fromEntries(
        readdirSync(assets)
          .filter((f) => f.endsWith(".css"))
          .map((f) => [`assets/${f}`, readFileSync(join(assets, f), "utf8")]),
      );
      const problems = guardianCssProblems(html, cssFiles);
      if (problems.length > 0) throw new Error(`CSS do tema no pacote dos responsáveis: ${problems.join("; ")}`);
    },
  };
}
