#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let ts;
try {
  ts = require('typescript');
} catch {
  console.error('TypeScript is required. Run `npm ci` in the installed frontend skill directory.');
  process.exit(2);
}

const appRoot = canonical(path.resolve(process.argv[2] ?? '.'));
const srcRoot = path.join(appRoot, 'src');
const sourceExtension = /\.(?:[cm]?[jt]sx?)$/;
const allowedRoots = new Set(['pages', 'feat', 'shared']);
const forbiddenPageDirs = new Set(['components', 'hooks', 'utils', 'services', 'store', 'types', 'styles', 'schemas', 'context', 'constants', 'lib']);
const errors = [];
const warnings = [];
const edges = new Map();

function canonical(file) {
  return fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
}

function rel(file) {
  return path.relative(appRoot, file).split(path.sep).join('/');
}

function issue(file, node, code, message) {
  const position = node ? node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()) : null;
  const location = position ? `:${position.line + 1}:${position.character + 1}` : '';
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
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function owner(file) {
  if (!inside(srcRoot, file)) return { layer: 'outside' };
  const parts = path.relative(srcRoot, file).split(path.sep);
  if (parts[0] === 'feat') return { layer: 'feat', feature: parts[1] };
  if (parts[0] === 'pages') return { layer: 'pages', route: parts.at(-1) === 'route.tsx' };
  if (parts[0] === 'shared') return { layer: 'shared' };
  return { layer: 'bootstrap' };
}

function checkLayout() {
  if (!fs.existsSync(srcRoot) || !fs.statSync(srcRoot).isDirectory()) {
    errors.push('src MISSING_SRC: application root must contain src/');
    return;
  }
  for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !allowedRoots.has(entry.name)) {
      errors.push(`src/${entry.name} INVALID_ROOT: only pages/, feat/, and shared/ may be architectural directories`);
    }
    if (entry.isSymbolicLink()) {
      errors.push(`src/${entry.name} SYMLINK_ROOT: symlinked roots cannot be validated safely`);
    }
  }
  for (const name of allowedRoots) {
    if (!fs.existsSync(path.join(srcRoot, name)) || !fs.statSync(path.join(srcRoot, name)).isDirectory()) {
      errors.push(`src/${name} MISSING_ROOT: required architectural directory is missing`);
    }
  }
  const pages = path.join(srcRoot, 'pages');
  if (fs.existsSync(pages)) {
    for (const file of walk(pages)) {
      if (!file.endsWith('.tsx')) issue(file, null, 'INVALID_PAGE_FILE', 'pages/ contains only page components (*.tsx) and route.tsx');
    }
    const groups = [pages, ...walkDirectories(pages)];
    for (const group of groups) {
      if (group !== pages && forbiddenPageDirs.has(path.basename(group))) {
        errors.push(`${rel(group)} INVALID_PAGE_DIRECTORY: pages/ cannot contain implementation directories`);
      }
      if (!fs.existsSync(path.join(group, 'route.tsx'))) {
        errors.push(`${rel(group)} MISSING_ROUTE: every page group requires route.tsx`);
      }
    }
  }
  const features = path.join(srcRoot, 'feat');
  if (fs.existsSync(features)) {
    for (const entry of fs.readdirSync(features, { withFileTypes: true })) {
      if (!entry.isDirectory()) errors.push(`src/feat/${entry.name} INVALID_FEATURE: each direct child of feat/ must be a feature directory`);
    }
  }
}

function walkDirectories(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const full = path.join(dir, entry.name);
    return [full, ...walkDirectories(full)];
  });
}

function compilerOptions() {
  const configFile = ts.findConfigFile(appRoot, ts.sys.fileExists, 'tsconfig.json');
  if (!configFile || !inside(appRoot, configFile)) {
    warnings.push('No tsconfig.json found in the application root; configured aliases cannot be resolved.');
    return { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, allowJs: true };
  }
  const raw = ts.readConfigFile(configFile, ts.sys.readFile);
  if (raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configFile));
  if (parsed.errors.length) throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  return { allowJs: true, ...parsed.options };
}

function matchesAlias(specifier, options) {
  if (specifier.startsWith('@/')) return true;
  return Object.keys(options.paths ?? {}).some((pattern) => {
    const star = pattern.indexOf('*');
    return star < 0 ? specifier === pattern : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
  });
}

function importsOf(sourceFile) {
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      imports.push({ node: node.moduleSpecifier, specifier: node.moduleSpecifier.text });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      imports.push({ node: node.moduleReference.expression, specifier: node.moduleReference.expression.text });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) imports.push({ node: arg, specifier: arg.text });
      else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) warnings.push(`${rel(sourceFile.fileName)}: dynamic import expression has no static target`);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return imports;
}

function checkBoundary(source, target, node) {
  const from = owner(source);
  const to = owner(target);
  if (to.layer === 'outside') {
    if (inside(appRoot, target)) issue(source, node, 'OUTSIDE_SRC', `local source ${rel(target)} is outside src/`);
    return;
  }
  if (from.layer === 'bootstrap' || to.layer === 'bootstrap') return;
  if (from.layer === 'shared' && to.layer !== 'shared') issue(source, node, 'SHARED_BOUNDARY', `shared/ cannot import ${rel(target)}`);
  if (from.layer === 'feat' && to.layer === 'pages') issue(source, node, 'FEATURE_TO_PAGES', `feature cannot import ${rel(target)}`);
  if (from.layer === 'feat' && to.layer === 'feat' && from.feature !== to.feature) issue(source, node, 'CROSS_FEATURE', `${from.feature} cannot import ${to.feature}`);
  if (from.layer === 'pages' && to.layer === 'pages') {
    if (!from.route) return issue(source, node, 'PAGE_TO_PAGE', `ordinary page cannot import ${rel(target)}`);
    const sourceDir = path.dirname(source);
    const targetDir = path.dirname(target);
    const ownPage = targetDir === sourceDir && !to.route;
    const childRoute = to.route && path.dirname(targetDir) === sourceDir;
    if (!ownPage && !childRoute) issue(source, node, 'INVALID_ROUTE_IMPORT', `route may import only its own pages or immediate child route.tsx: ${rel(target)}`);
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
        const cycle = [...stack.slice(stack.indexOf(target)), target].map(rel).join(' → ');
        if (!reported.has(cycle)) {
          errors.push(`${rel(file)} CIRCULAR_DEPENDENCY: ${cycle}`);
          reported.add(cycle);
        }
      } else if (!state.has(target)) visit(target);
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
    const files = walk(srcRoot).filter((file) => sourceExtension.test(file));
    for (const file of files) {
      const source = canonical(file);
      const sourceFile = ts.createSourceFile(source, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      edges.set(source, new Set());
      for (const { node, specifier } of importsOf(sourceFile)) {
        const resolved = ts.resolveModuleName(specifier, source, options, ts.sys, cache).resolvedModule;
        if (!resolved) {
          if (specifier.startsWith('.') || path.isAbsolute(specifier) || matchesAlias(specifier, options)) issue(source, node, 'UNRESOLVED_LOCAL', `cannot resolve ${specifier}`);
          continue;
        }
        const target = canonical(resolved.resolvedFileName);
        if (inside(srcRoot, target)) {
          edges.get(source).add(target);
          checkBoundary(source, target, node);
        } else if (!resolved.isExternalLibraryImport && inside(appRoot, target)) {
          issue(source, node, 'OUTSIDE_SRC', `local source ${rel(target)} is outside src/`);
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
  console.error(`Architecture validation failed: ${errors.length} issue(s).`);
  process.exit(1);
}
console.log(`Architecture validation passed for ${rel(srcRoot)}.`);
