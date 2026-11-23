#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let ts;
try {
  ts = require("typescript");
} catch {
  console.error("TypeScript is required. Run `npm ci` in the installed backend skill directory.");
  process.exit(2);
}

const appRoot = canonical(path.resolve(process.argv[2] ?? "."));
const srcRoot = path.join(appRoot, "src");
const modulesRoot = path.join(srcRoot, "modules");
const generatedRoot = path.join(srcRoot, "generated");
const testsRoot = path.join(appRoot, "tests");
const sourceExtension = /\.(?:[cm]?[jt]sx?)$/;
const testFilePattern = /\.(test|spec)\.[cm]?[jt]sx?$/;
const requiredModuleLayers = ["api", "schemas", "services", "repositories"];
const requiredTestDirs = [
  "unit/core",
  "unit/feature",
  "unit/integration",
  "unit/scripts",
  "integration",
  "perf",
];
const forbiddenLayerEdges = new Set([
  "api>repositories",
  "schemas>api",
  "schemas>services",
  "schemas>repositories",
  "services>api",
  "repositories>api",
  "repositories>services",
]);
const errors = [];
const warnings = [];
const edges = new Map();

function canonical(file) {
  return fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
}

function rel(file) {
  return path.relative(appRoot, file).split(path.sep).join("/");
}

function issue(file, node, code, message) {
  const position = node ? node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()) : null;
  const location = position ? `:${position.line + 1}:${position.character + 1}` : "";
  errors.push(`${rel(file)}${location} ${code}: ${message}`);
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`${rel(full)} SYMLINK_SOURCE: symlinked source paths cannot be validated safely`);
      return [];
    }
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function partsIn(root, file) {
  if (!inside(root, file)) return null;
  return path.relative(root, file).split(path.sep);
}

function owner(file) {
  const parts = partsIn(srcRoot, file);
  if (!parts) return { layer: "outside" };
  if (parts[0] === "modules") {
    return { layer: "modules", module: parts[1], role: parts[2] ?? "", root: parts.length === 2 };
  }
  if (parts[0] === "shared") return { layer: "shared" };
  if (parts[0] === "db") return { layer: "db" };
  if (parts[0] === "generated") return { layer: "generated" };
  if (parts[0] === "integrations") return { layer: "integrations" };
  if (parts[0] === "scripts") return { layer: "scripts" };
  return { layer: "bootstrap" };
}

function checkLayout() {
  if (!fs.existsSync(srcRoot) || !fs.statSync(srcRoot).isDirectory()) {
    errors.push("src MISSING_SRC: backend application root must contain src/");
    return;
  }
  for (const file of walk(srcRoot)) {
    if (testFilePattern.test(file)) issue(file, null, "TEST_IN_SRC", "test and spec files belong in tests/, not src/");
  }
  if (!fs.existsSync(modulesRoot) || !fs.statSync(modulesRoot).isDirectory()) {
    errors.push("src/modules MISSING_MODULES: Arctis backend requires src/modules/");
    return;
  }
  for (const entry of fs.readdirSync(modulesRoot, { withFileTypes: true })) {
    const moduleRoot = path.join(modulesRoot, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`${rel(moduleRoot)} SYMLINK_SOURCE: symlinked modules cannot be validated safely`);
      continue;
    }
    if (!entry.isDirectory()) {
      errors.push(`${rel(moduleRoot)} INVALID_MODULE: every child of src/modules/ must be a directory`);
      continue;
    }
    for (const layer of requiredModuleLayers) {
      const layerRoot = path.join(moduleRoot, layer);
      if (!fs.existsSync(layerRoot) || !fs.statSync(layerRoot).isDirectory()) {
        errors.push(`${rel(layerRoot)} MISSING_LAYER: module requires ${layer}/`);
      }
    }
    for (const file of fs.readdirSync(moduleRoot, { withFileTypes: true })) {
      const full = path.join(moduleRoot, file.name);
      if (file.isFile() && /\.tsx?$/.test(file.name) && !file.name.endsWith(".d.ts")) {
        errors.push(`${rel(full)} MODULE_ROOT_FILE: implementation belongs in api/, schemas/, services/, or repositories/`);
      }
    }
  }
  if (!fs.existsSync(testsRoot) || !fs.statSync(testsRoot).isDirectory()) {
    errors.push("tests MISSING_TESTS: backend application root must contain tests/");
    return;
  }
  for (const dir of requiredTestDirs) {
    const full = path.join(testsRoot, ...dir.split("/"));
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) {
      errors.push(`tests/${dir} MISSING_TEST_DIR: required test directory is missing`);
    }
  }
  const unitRoot = path.join(testsRoot, "unit");
  if (fs.existsSync(unitRoot)) {
    for (const entry of fs.readdirSync(unitRoot, { withFileTypes: true })) {
      if (entry.isFile() && /\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
        errors.push(`tests/unit/${entry.name} TEST_PLACEMENT: move tests into core/, feature/, integration/, or scripts/`);
      }
    }
  }
}

function compilerOptions() {
  const configFile = ts.findConfigFile(appRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configFile || !inside(appRoot, configFile)) {
    warnings.push("No tsconfig.json found in the application root; configured aliases cannot be resolved.");
    return {
      allowJs: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
    };
  }
  const raw = ts.readConfigFile(configFile, ts.sys.readFile);
  if (raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configFile));
  if (parsed.errors.length) {
    throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
  }
  return { allowJs: true, ...parsed.options };
}

function matchesAlias(specifier, options) {
  if (specifier.startsWith("@/")) return true;
  return Object.keys(options.paths ?? {}).some((pattern) => {
    const star = pattern.indexOf("*");
    return (
      star < 0
        ? specifier === pattern
        : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1))
    );
  });
}

function importsOf(sourceFile) {
  const imports = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      imports.push({ node: node.moduleSpecifier, specifier: node.moduleSpecifier.text });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      imports.push({ node: node.moduleReference.expression, specifier: node.moduleReference.expression.text });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) imports.push({ node: arg, specifier: arg.text });
      else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        warnings.push(`${rel(sourceFile.fileName)}: dynamic import expression has no static target`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports;
}

function checkBoundary(source, target, node) {
  const from = owner(source);
  const to = owner(target);
  if (to.layer === "outside") {
    if (inside(appRoot, target)) issue(source, node, "OUTSIDE_SRC", `local source ${rel(target)} is outside src/`);
    return;
  }
  if (from.layer === "generated" || to.layer === "generated") return;
  if (from.layer === "bootstrap" || to.layer === "bootstrap") return;
  if (from.layer === "scripts" || to.layer === "scripts") return;
  if (from.layer === "integrations" || to.layer === "integrations") return;

  if (from.layer === "db" && to.layer === "modules") {
    issue(source, node, "DB_BOUNDARY", `db/ cannot import ${rel(target)}`);
    return;
  }
  if (from.layer === "shared" && to.layer === "modules") {
    issue(source, node, "SHARED_BOUNDARY", `shared/ cannot import ${rel(target)}`);
    return;
  }
  if (from.layer !== "modules") return;

  if (to.layer === "modules") {
    if (from.module !== to.module) {
      issue(source, node, "CROSS_MODULE", `${from.module} cannot import ${to.module}`);
      return;
    }
    if (forbiddenLayerEdges.has(`${from.role}>${to.role}`)) {
      issue(source, node, "LAYER_BOUNDARY", `${from.role}/ cannot import ${to.role}/ in the same module`);
    }
    return;
  }
  if (to.layer === "db" && ["api", "services", "schemas"].includes(from.role)) {
    issue(source, node, "DB_BOUNDARY", `${from.role}/ cannot import ${rel(target)}; use repositories/`);
  }
}

function checkCycles() {
  const state = new Map();
  const stack = [];
  const reported = new Set();
  function visit(file) {
    state.set(file, 1);
    stack.push(file);
    for (const target of edges.get(file) ?? []) {
      if (state.get(target) === 1) {
        const cycle = [...stack.slice(stack.indexOf(target)), target].map(rel).join(" -> ");
        if (!reported.has(cycle)) {
          errors.push(`${rel(file)} CIRCULAR_DEPENDENCY: ${cycle}`);
          reported.add(cycle);
        }
      } else if (!state.has(target)) {
        visit(target);
      }
    }
    stack.pop();
    state.set(file, 2);
  }
  for (const file of edges.keys()) if (!state.has(file)) visit(file);
}

try {
  checkLayout();
  if (fs.existsSync(srcRoot)) {
    const options = compilerOptions();
    const cache = ts.createModuleResolutionCache(appRoot, (name) => name, options);
    const files = walk(srcRoot).filter(
      (file) =>
        sourceExtension.test(file) && !file.endsWith(".d.ts") && !inside(generatedRoot, file),
    );
    for (const file of files) {
      const source = canonical(file);
      const sourceFile = ts.createSourceFile(
        source,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      edges.set(source, new Set());
      for (const { node, specifier } of importsOf(sourceFile)) {
        const resolved = ts.resolveModuleName(specifier, source, options, ts.sys, cache).resolvedModule;
        if (!resolved) {
          if (specifier.startsWith(".") || path.isAbsolute(specifier) || matchesAlias(specifier, options)) {
            issue(source, node, "UNRESOLVED_LOCAL", `cannot resolve ${specifier}`);
          }
          continue;
        }
        const target = canonical(resolved.resolvedFileName);
        if (inside(srcRoot, target)) {
          edges.get(source).add(target);
          checkBoundary(source, target, node);
        } else if (!resolved.isExternalLibraryImport && inside(appRoot, target)) {
          issue(source, node, "OUTSIDE_SRC", `local source ${rel(target)} is outside src/`);
        }
      }
    }
    checkCycles();
  }
} catch (error) {
  console.error(`Architecture validator could not run: ${error.message}`);
  process.exit(2);
}

for (const warning of warnings) console.warn(`WARN ${warning}`);
for (const error of errors) console.error(error);
if (errors.length) {
  console.error(`Backend architecture validation failed: ${errors.length} issue(s).`);
  process.exit(1);
}
console.log(`Backend architecture validation passed for ${rel(srcRoot)}.`);
