#!/usr/bin/env node
// Builds the worker program's shared parts (docs/gpu-workers.md) into bin/lib/worker/dist/:
//   - the job runner the browser uses (src/lib/computer-runner.ts and its helpers), transpiled to plain .mjs with the
//     typescript dev dependency, relative imports rewritten to .mjs;
//   - allowed-nodes.json: every node type the studio's workflows and graph builders use, frozen into the worker. The
//     studio can't add to it; a worker refuses a graph with any other node.
// `pnpm build` runs it first. No new dependency.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { studioNodes } from "./lib/studio-nodes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "bin/lib/worker/dist");
const SOURCES = ["computer-runner", "comfy-guard", "comfy-ws", "fetch-within", "local-comfy", "relay", "lanes", "worker-hours"];

fs.mkdirSync(out, { recursive: true });
for (const name of SOURCES) {
  const src = fs.readFileSync(path.join(root, "src/lib", `${name}.ts`), "utf8");
  const { outputText } = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false, isolatedModules: true }, fileName: `${name}.ts` });
  const js = outputText.replace(/from "\.\/([\w-]+)"/g, (m, dep) => {
    if (!SOURCES.includes(dep)) throw new Error(`${name}.ts imports ./${dep}, which the worker build doesn't include`);
    return `from "./${dep}.mjs"`;
  });
  if (/from "(@\/|\.\.\/)/.test(js)) throw new Error(`${name}.ts imports something outside src/lib's worker files`);
  fs.writeFileSync(path.join(out, `${name}.mjs`), `// Built from src/lib/${name}.ts by scripts/build-worker.mjs. Don't edit.\n${js}`);
}

// The node allowlist (the same list Fuobe Connect ships: scripts/connect-nodes.mjs).
const list = studioNodes(root);
fs.writeFileSync(path.join(out, "allowed-nodes.json"), `${JSON.stringify({ built: "scripts/build-worker.mjs", nodes: list }, null, 1)}\n`);
console.log(`worker: ${SOURCES.length} modules, ${list.length} allowed node types -> ${path.relative(root, out)}`);
