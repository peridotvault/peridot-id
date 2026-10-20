#!/usr/bin/env node
/**
 * check-env-ownership.mjs (OWNER: Trevor, DevOps — spec ANT-154 rules R5/R1, AC7).
 *
 * Machine check, not discipline: asserts canonical env ownership across every
 * `*.example` file so key drift fails fast in CI instead of leaking into deploys.
 *
 * - Node stdlib only, zero new runtime deps (NFR: <5s on a cold checkout).
 * - Keys only: parses `KEY=` / `KEY =` assignments from uncommented lines and
 *   `# KEY=` doc-comments; never reads values, never prints values.
 *
 * Checks:
 *  1. root `.env.example` exists and carries `# OWNER: root` section markers.
 *  2. `apps/api/.env.example` carries ZERO `VITE_*` / `NEXT_PUBLIC_*` keys (AC1).
 *  3. `apps/wallet/.env.example` carries ONLY `VITE_*` keys (frontend twin parity
 *     itself is Thomas/ANT-156 turf — this script only guards the prefix boundary).
 *  4. `packages/db/.env.example`, when present, is a 0-key pointer file (AC3).
 *     Absent (no db package in this repo — Prisma lives in apps/api) = N/A pass.
 *  5. Deploy overlays (`deploy/.env.{main,test}.example`): every extra key vs the
 *     (root ∪ app allowlists) union must be in the deploy-owned allowlist (AC4,
 *     adapted to peridot-id: ENV_SUFFIX, NAMESPACE, TAG, NEW_*_HOST, DASHBOARD_*,
 *     plus deploy-pinned runtime refs BREVO_API_KEY/NODE_ENV/etc. — see
 *     DEPLOY_OWNED below). Any other extra fails.
 *  6. Banned placements: ENV_SUFFIX / NAMESPACE / TAG outside `deploy/`;
 *     `NEXT_PUBLIC_*` anywhere (no Next.js in this repo).
 *  7. Compose coverage: every `${VAR}` interpolated in `deploy/compose.yaml`
 *     without an inline `:-` default must resolve from at least one of: an
 *     example file, an up.sh per-stack default (KNOWN_UP_SH_DEFAULTS), or the
 *     explicitly-optional legacy set (KNOWN_OPTIONAL, warn-only, never fail).
 *
 * Exit non-zero with `KEY → owner vs duplicate` lines on failure (AC7).
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const warnings = [];
const fail = (msg) => failures.push(msg);
const warn = (msg) => warnings.push(msg);

/** Parse keys-only from an env example file. Returns { keys:Set, commented:Set }. */
function parseKeys(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return null;
  const keys = new Set();
  const commented = new Set();
  for (const raw of readFileSync(abs, "utf8").split("\n")) {
    const line = raw.trim();
    let m = line.match(/^([A-Z][A-Z0-9_]*)\s*=/);
    if (m) {
      keys.add(m[1]);
      continue;
    }
    m = line.match(/^#\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (m) commented.add(m[1]);
  }
  return { keys, commented };
}

function keyList(set) {
  return [...set].sort().join(", ") || "(none)";
}

// ---- 1. root canonical doc ----
const root = parseKeys(".env.example");
if (!root) {
  fail("root .env.example → MISSING (owner: root, expected canonical doc)");
} else {
  const text = readFileSync(join(ROOT, ".env.example"), "utf8");
  if (!text.includes("# OWNER: root") && !text.includes("OWNER: root")) {
    fail("root .env.example → MISSING OWNER header (expected `# OWNER: root` markers)");
  }
  if (root.keys.size === 0) fail("root .env.example → 0 keys (canonical doc must define shared keys)");
}

// ---- inventory ----
const api = parseKeys("apps/api/.env.example");
const wallet = parseKeys("apps/wallet/.env.example");
const mainOv = parseKeys("deploy/.env.main.example");
const testOv = parseKeys("deploy/.env.test.example");
const dbEx = parseKeys("packages/db/.env.example");

if (!api) fail("apps/api/.env.example → MISSING");
if (!wallet) fail("apps/wallet/.env.example → MISSING");
if (!mainOv) fail("deploy/.env.main.example → MISSING");
if (!testOv) fail("deploy/.env.test.example → MISSING");

// ---- 2. api: zero frontend-prefixed keys (AC1 sad path) ----
if (api) {
  const bad = [...api.keys].filter((k) => k.startsWith("VITE_") || k.startsWith("NEXT_PUBLIC_"));
  if (bad.length > 0) fail(`apps/api/.env.example → frontend keys owned elsewhere: ${bad.sort().join(", ")} (owner: web/wallet/admin, not api)`);
}

// ---- 3. wallet: only VITE_* ----
if (wallet) {
  const bad = [...wallet.keys].filter((k) => !k.startsWith("VITE_"));
  if (bad.length > 0) fail(`apps/wallet/.env.example → non-VITE keys: ${bad.sort().join(", ")} (wallet is Vite-public only)`);
}

// ---- 4. packages/db pointer (AC3) ----
if (dbEx && dbEx.keys.size > 0) {
  fail(`packages/db/.env.example → ${dbEx.keys.size} keys (${keyList(dbEx.keys)}); expected 0-key pointer to repo-root .env`);
} else if (!dbEx) {
  warn("packages/db/.env.example → ABSENT (N/A: no db package in this repo; Prisma lives in apps/api) — check skipped");
}

// ---- 5. deploy overlay extras ⊆ allowlist (AC4 adapted) ----
const DEPLOY_OWNED = new Set([
  // deploy meta (up.sh per-stack defaults; env-file wins when set)
  "ENV_SUFFIX", "NAMESPACE", "TAG",
  "NEW_API_HOST", "NEW_WALLET_HOST", "NEW_DASHBOARD_HOST", "NEW_DOCS_HOST",
  // dashboard build args (OWNER: deploy; compose dashboard service)
  "DASHBOARD_API_URL", "DASHBOARD_POPUP_URL", "DASHBOARD_PID_ENV",
  "DASHBOARD_PID_CLIENT_ID", "DASHBOARD_OTHER_WORKSPACE_URL",
  // deploy-pinned runtime refs (OWNER: root, deploy carries them for the
  // Infisical-fallback path + compose interpolation completeness, R4)
  "NODE_ENV", "BREVO_API_KEY", "DOKU_WEBHOOK_URL", "DOKU_CHECKOUT_NOTIFY_URL",
  "CLIENT_REDIRECT_ALLOWLIST", "APP_TOKEN_TTL",
]);
const union = new Set([
  ...(root ? root.keys : []),
  ...(api ? api.keys : []),
  ...(wallet ? wallet.keys : []),
]);
for (const [name, ov] of [["deploy/.env.main.example", mainOv], ["deploy/.env.test.example", testOv]]) {
  if (!ov) continue;
  // Extras = keys in the overlay but not in root∪apps; allowlisted ones pass.
  const realExtras = [...ov.keys].filter((k) => !union.has(k));
  const bad = realExtras.filter((k) => !DEPLOY_OWNED.has(k));
  if (bad.length > 0) {
    fail(`${name} → unexplained extras beyond allowlist: ${bad.sort().join(", ")} (owner: declare in DEPLOY_OWNED or move to the owning file)`);
  }
}

// ---- 6. banned placements ----
const ALL_EXAMPLES = [];
(function collect(dir, prefix) {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = prefix + e.name;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
      collect(join(dir, e.name), rel + "/");
    } else if (e.name.endsWith(".example")) {
      ALL_EXAMPLES.push(rel);
    }
  }
})(".", "./");
for (const rel of ALL_EXAMPLES) {
  const p = parseKeys(rel);
  if (!p) continue;
  const inDeploy = rel.startsWith("./deploy/");
  for (const k of ["ENV_SUFFIX", "NAMESPACE", "TAG"]) {
    if (p.keys.has(k) && !inDeploy) fail(`${rel} → deploy-only key ${k} outside deploy/ (owner: deploy)`);
  }
  const nextKeys = [...p.keys].filter((k) => k.startsWith("NEXT_PUBLIC_"));
  if (nextKeys.length > 0) fail(`${rel} → NEXT_PUBLIC_* keys with no Next.js consumer: ${nextKeys.sort().join(", ")}`);
}

// ---- 7. compose coverage ----
const KNOWN_UP_SH_DEFAULTS = new Set([
  // Exported by deploy/up.sh per-stack before compose runs (`${VAR:-default}`).
  "ENV_SUFFIX", "NAMESPACE", "NEW_API_HOST", "NEW_WALLET_HOST",
  "NEW_DASHBOARD_HOST", "NEW_DOCS_HOST",
  "DASHBOARD_API_URL", "DASHBOARD_POPUP_URL", "DASHBOARD_PID_ENV",
  "DASHBOARD_OTHER_WORKSPACE_URL",
]);
const KNOWN_OPTIONAL = new Set([
  // Retired/frozen Sub-Account hierarchy (commented in examples, unset at
  // runtime, referenced by compose without default). Explicitly optional:
  // warn-only, never fail. Revisit if DOKU re-activates Sub-Accounts.
  "DOKU_USERS_PARENT_PROFILE_ID", "DOKU_TREASURY_PROFILE_ID",
  "DOKU_TREASURY_ACCOUNT_NO", "DOKU_SYSTEM_POINT_ACCOUNT_NO",
  "DOKU_TREASURY_POINT_ACCOUNT_NO",
]);
const composePath = join(ROOT, "deploy/compose.yaml");
if (!existsSync(composePath)) {
  fail("deploy/compose.yaml → MISSING (cannot verify interpolation coverage)");
} else {
  const compose = readFileSync(composePath, "utf8");
  const refs = new Set();
  const re = /\$\{([A-Z][A-Z0-9_]*)(?::-[^}]*)?\}/g;
  let m;
  while ((m = re.exec(compose)) !== null) refs.add(m[1]);
  const provided = new Set([
    ...(root ? root.keys : []),
    ...(api ? api.keys : []),
    ...(wallet ? wallet.keys : []),
    ...(mainOv ? mainOv.keys : []),
    ...(testOv ? testOv.keys : []),
  ]);
  // Vars with inline compose defaults always resolve — check the raw text.
  const withDefault = new Set();
  const reD = /\$\{([A-Z][A-Z0-9_]*):-[^}]*\}/g;
  while ((m = reD.exec(compose)) !== null) withDefault.add(m[1]);
  for (const v of [...refs].sort()) {
    if (/^[0-9]/.test(v)) continue;
    if (withDefault.has(v)) continue;
    if (provided.has(v)) continue;
    if (KNOWN_UP_SH_DEFAULTS.has(v)) continue;
    if (KNOWN_OPTIONAL.has(v)) {
      warn(`compose references optional-unset \${${v}} (no default, absent from examples — sanctioned legacy, warn-only)`);
      continue;
    }
    fail(`deploy/compose.yaml → \${${v}} has no default and no example-file owner (add to owning *.example or compose :-\u200bdefault)`);
  }
}

// ---- report ----
for (const w of warnings) console.log(`warn: ${w}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL: ${f}`);
  console.log(`\ncheck-env-ownership: ${failures.length} failure(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`check-env-ownership: OK (${warnings.length} warning(s)) — root/app/deploy ownership holds.`);
