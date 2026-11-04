#!/usr/bin/env node
// Report-only API↔spec coverage: every NestJS route that is not in the OpenAPI
// spec gets printed. `/admin` and `/health` are internal by policy, so they are
// counted separately instead of drowning the report.
//
//   node packages/openapi/scripts/check-coverage.mjs          # report, exit 0
//   node packages/openapi/scripts/check-coverage.mjs --strict  # exit 1 on gaps
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const apiSrc = join(root, "apps/api/src");
const specPath = join(root, "packages/openapi/src/openapi.yaml");
const INTERNAL = ["/admin", "/health"];

const controllers = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".controller.ts")) controllers.push(p);
  }
};
walk(apiSrc);

const routes = new Set();
for (const file of controllers) {
  const text = readFileSync(file, "utf8");
  const base = (text.match(/@Controller\(([^)]*)\)/)?.[1] ?? "").replace(/["'`]/g, "").trim();
  const re = /@(Get|Post|Put|Patch|Delete)\(\s*(["'`]?)([^)"'`]*)\2\s*\)/g;
  for (const m of text.matchAll(re)) {
    const path = `/${[base, (m[3] ?? "").trim()].filter(Boolean).join("/")}`.replace(/\/+/g, "/");
    routes.add(`${m[1].toUpperCase()} ${path.replace(/\/$/, "") || "/"}`);
  }
}

const spec = readFileSync(specPath, "utf8");
const documented = new Set([...spec.matchAll(/^ {2}(\/[^\s:]+):/gm)].map((m) => m[1]));
const norm = (p) => p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

const gaps = [];
const internal = [];
for (const route of [...routes].sort()) {
  const path = norm(route.split(" ")[1].replace(/^\/v1/, ""));
  if (documented.has(path)) continue;
  (INTERNAL.some((p) => path.startsWith(p)) ? internal : gaps).push(route);
}

const total = routes.size;
console.log(
  `api-docs coverage: ${total - gaps.length - internal.length}/${total} documented ` +
    `(${internal.length} internal, ${gaps.length} gap${gaps.length === 1 ? "" : "s"})`,
);
for (const g of gaps) console.log(`  gap: ${g}`);

if (process.argv.includes("--strict") && gaps.length > 0) process.exit(1);
