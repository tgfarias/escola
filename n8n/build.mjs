// Gera o jsCode de cada Code node marcado com "notes": "code:<arquivo>" = lib.js + "\n" + <arquivo>.
import process from "node:process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export function codeFor(file) {
  const lib = readFileSync(join(root, "code", "lib.js"), "utf8");
  return `${lib}\n${readFileSync(join(root, "code", file), "utf8")}`;
}

export function buildWorkflow(workflow) {
  for (const node of workflow.nodes) {
    const match = /^code:(.+)$/.exec(node.notes ?? "");
    if (match) node.parameters.jsCode = codeFor(match[1]);
  }
  return workflow;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = join(root, "workflows");
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const path = join(dir, name);
    const built = buildWorkflow(JSON.parse(readFileSync(path, "utf8")));
    writeFileSync(path, `${JSON.stringify(built, null, 2)}\n`);
  }
}
