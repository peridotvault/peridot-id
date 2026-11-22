import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const validator = fileURLToPath(new URL('../scripts/validate-architecture.mjs', import.meta.url));
const baseline = {
  'pages/route.tsx': "import './home'; import './settings/route';",
  'pages/home.tsx': 'export default function Home() { return null; }',
  'pages/profile.tsx': 'export default function Profile() { return null; }',
  'pages/settings/route.tsx': "import './index';",
  'pages/settings/index.tsx': 'export default function Settings() { return null; }',
  'pages/dashboard/route.tsx': "import './index';",
  'pages/dashboard/index.tsx': 'export default function Dashboard() { return null; }',
  'feat/home/components/Hero.tsx': 'export const Hero = 1;',
  'feat/auth/hooks/useLogin.ts': 'export const useLogin = 1;',
  'feat/auth/services/login.ts': 'export const login = 1;',
  'feat/auth/utils/token.ts': 'export const token = 1;',
  'feat/auth/components/LoginForm.tsx': 'export const LoginForm = 1;',
  'feat/user/hooks/useUser.ts': 'export const useUser = 1;',
  'feat/user/services/user.ts': 'export const user = 1;',
  'shared/components/Button.tsx': 'export const Button = 1;',
  'shared/hooks/useDebounce.ts': 'export const useDebounce = 1;',
  'shared/utils/timer.ts': 'export const timer = 1;',
  'shared/utils/example.ts': 'export const example = 1;',
};

function fixture(changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arctis-frontend-'));
  for (const name of ['pages', 'feat', 'shared']) fs.mkdirSync(path.join(root, 'src', name), { recursive: true });
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', jsx: 'preserve', paths: { '@/*': ['./src/*'], '~/*': ['./src/*'] } } }));
  for (const [name, content] of Object.entries({ ...baseline, ...changes })) {
    const target = path.join(root, 'src', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function validate(root) {
  const result = spawnSync(process.execPath, [validator, root], { encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

test('baseline route tree and all three roots pass', () => {
  const root = fixture();
  try { assert.equal(validate(root).status, 0); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const importCases = [
  ['pages → feature', 'pages/home.tsx', 'feat/home/components/Hero.tsx', "import '@/feat/home/components/Hero';", 0],
  ['pages → shared', 'pages/home.tsx', 'shared/components/Button.tsx', "import '@/shared/components/Button';", 0],
  ['same feature', 'feat/auth/hooks/useLogin.ts', 'feat/auth/services/login.ts', "import '../services/login';", 0],
  ['feature → shared', 'feat/auth/components/LoginForm.tsx', 'shared/components/Button.tsx', "import '@/shared/components/Button';", 0],
  ['shared → shared', 'shared/hooks/useDebounce.ts', 'shared/utils/timer.ts', "import '../utils/timer';", 0],
  ['cross feature auth → user', 'feat/auth/hooks/useLogin.ts', 'feat/user/services/user.ts', "import '@/feat/user/services/user';", 1],
  ['cross feature user → auth', 'feat/user/hooks/useUser.ts', 'feat/auth/utils/token.ts', "import '../../auth/utils/token';", 1],
  ['shared → feature', 'shared/components/Button.tsx', 'feat/auth/hooks/useLogin.ts', "import '@/feat/auth/hooks/useLogin';", 1],
  ['shared → page', 'shared/utils/example.ts', 'pages/home.tsx', "import '@/pages/home';", 1],
  ['feature → page', 'feat/auth/services/login.ts', 'pages/home.tsx', "import '@/pages/home';", 1],
  ['page → page', 'pages/home.tsx', 'pages/profile.tsx', "import './profile';", 1],
  ['page → route', 'pages/home.tsx', 'pages/route.tsx', "import './route';", 1],
  ['root route → child route', 'pages/route.tsx', 'pages/settings/route.tsx', "import './settings/route';", 0],
  ['group route → own page', 'pages/settings/route.tsx', 'pages/settings/index.tsx', "import './index';", 0],
  ['group route → unrelated root page', 'pages/settings/route.tsx', 'pages/home.tsx', "import '../home';", 1],
  ['group route → sibling route', 'pages/settings/route.tsx', 'pages/dashboard/route.tsx', "import '../dashboard/route';", 1],
];

for (const [label, source, target, statement, expected] of importCases) {
  test(label, () => {
    const root = fixture({ [source]: statement });
    try {
      assert.ok(fs.existsSync(path.join(root, 'src', target)));
      const result = validate(root);
      assert.equal(result.status, expected, result.output);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

const bypassCases = [
  ['type-only cross feature', 'feat/auth/hooks/useLogin.ts', "import type { user } from '../../user/services/user';"],
  ['barrel re-export', 'feat/auth/index.ts', "export { user } from '../user/services/user';"],
  ['relative cross feature', 'feat/auth/hooks/useLogin.ts', "import '../../user/services/user';"],
  ['alternative alias', 'feat/auth/hooks/useLogin.ts', "import '~/feat/user/services/user';"],
  ['literal dynamic import', 'feat/auth/hooks/useLogin.ts', "void import('../../user/services/user');"],
  ['require import', 'feat/auth/hooks/useLogin.ts', "require('../../user/services/user');"],
];

for (const [label, source, statement] of bypassCases) {
  test(label, () => {
    const root = fixture({ [source]: statement });
    try { assert.equal(validate(root).status, 1); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('circular imports fail even inside one feature', () => {
  const root = fixture({ 'feat/auth/services/login.ts': "import '../hooks/useLogin';", 'feat/auth/hooks/useLogin.ts': "import '../services/login';" });
  try { assert.match(validate(root).output, /CIRCULAR_DEPENDENCY/); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unexpected root directory fails', () => {
  const root = fixture({ 'components/Button.tsx': 'export const Button = 1;' });
  try { assert.match(validate(root).output, /INVALID_ROOT/); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('every route group requires route.tsx', () => {
  const root = fixture({ 'pages/reports/index.tsx': 'export default function Reports() { return null; }' });
  try { assert.match(validate(root).output, /MISSING_ROUTE/); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('page implementation directory and TypeScript utility fail', () => {
  const root = fixture({ 'pages/hooks/usePage.ts': 'export const usePage = 1;' });
  try { assert.match(validate(root).output, /INVALID_PAGE_FILE/); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('page implementation directory fails even when it has route.tsx', () => {
  const root = fixture({ 'pages/hooks/route.tsx': 'export const routes = [];', 'pages/hooks/usePage.tsx': 'export const usePage = 1;' });
  try { assert.match(validate(root).output, /INVALID_PAGE_DIRECTORY/); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('indirect barrel access cannot hide a cross-feature dependency', () => {
  const root = fixture({ 'feat/auth/index.ts': "export { user } from '../user/services/user';", 'feat/auth/hooks/useLogin.ts': "import '../index';" });
  try { assert.match(validate(root).output, /CROSS_FEATURE/); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('symlinked source cannot bypass ownership checks', () => {
  const root = fixture();
  try {
    fs.symlinkSync(path.join(root, 'src', 'feat', 'user'), path.join(root, 'src', 'feat', 'auth', 'linked-user'));
    assert.match(validate(root).output, /SYMLINK_SOURCE/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('nonliteral dynamic import reports a limitation', () => {
  const root = fixture({ 'feat/auth/hooks/useLogin.ts': "const name = 'login'; void import(name);" });
  try {
    const result = validate(root);
    assert.equal(result.status, 0);
    assert.match(result.output, /dynamic import expression has no static target/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
