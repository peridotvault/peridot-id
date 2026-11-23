import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const validator = fileURLToPath(new URL("../scripts/validate-architecture.mjs", import.meta.url));
const baseline = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "NodeNext",
      target: "ES2022",
      paths: {
        "@/*": ["./src/*"],
        "~/*": ["./src/*"],
      },
    },
  }),
  "src/app.ts": "export const app = 1;",
  "src/routes.ts": 'import { users } from "./modules/users/api/users.js"; export { users };',
  "src/env.ts": "export const env = 1;",
  "src/openapi.ts": "export const openapiDocument = {};",
  "src/db/client.ts": "export const prisma = {};",
  "src/generated/prisma/enums.ts": "export const UserRole = { ADMIN: 'ADMIN' };",
  "src/shared/http/errors.ts": "export class HttpError extends Error {}",
  "src/modules/users/api/users.ts": "export const users = 1;",
  "src/modules/users/schemas/user.schema.ts": "export const createUserSchema = 1;",
  "src/modules/users/services/users.service.ts": "export const createUser = 1;",
  "src/modules/users/services/other.service.ts": "export const other = 1;",
  "src/modules/users/repositories/users.repository.ts": "export const findUser = 1;",
  "src/modules/billing/api/billing.ts": "export const billing = 1;",
  "src/modules/billing/schemas/billing.schema.ts": "export const billingSchema = 1;",
  "src/modules/billing/services/billing.service.ts": "export const bill = 1;",
  "src/modules/billing/repositories/billing.repository.ts": "export const findBill = 1;",
  "src/scripts/scan-due.ts": "export const scan = 1;",
};

function fixture(changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arctis-backend-"));
  for (const dir of [
    "src/modules/users/api",
    "src/modules/users/schemas",
    "src/modules/users/services",
    "src/modules/users/repositories",
    "src/modules/billing/api",
    "src/modules/billing/schemas",
    "src/modules/billing/services",
    "src/modules/billing/repositories",
    "src/shared/http",
    "src/db",
    "src/generated/prisma",
    "src/scripts",
    "tests/unit/core",
    "tests/unit/feature",
    "tests/unit/integration",
    "tests/unit/scripts",
    "tests/integration",
    "tests/perf",
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const [name, content] of Object.entries({ ...baseline, ...changes })) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function validate(root) {
  const result = spawnSync(process.execPath, [validator, root], { encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

test("baseline module tree passes", () => {
  const root = fixture();
  try {
    assert.equal(validate(root).status, 0, validate(root).output);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const importCases = [
  ["api -> own services", "src/modules/users/api/users.ts", "import { createUser } from '../services/users.service.js';", 0],
  ["api -> own schemas", "src/modules/users/api/users.ts", "import { createUserSchema } from '../schemas/user.schema.js';", 0],
  ["services -> own repositories", "src/modules/users/services/users.service.ts", "import { findUser } from '../repositories/users.repository.js';", 0],
  ["services -> own schemas", "src/modules/users/services/users.service.ts", "import { createUserSchema } from '../schemas/user.schema.js';", 0],
  ["repositories -> own schemas", "src/modules/users/repositories/users.repository.ts", "import { createUserSchema } from '../schemas/user.schema.js';", 0],
  ["module -> shared", "src/modules/users/api/users.ts", "import { HttpError } from '../../../shared/http/errors.js';", 0],
  ["repositories -> db", "src/modules/users/repositories/users.repository.ts", "import { prisma } from '../../../db/client.js';", 0],
  ["module -> generated", "src/modules/users/api/users.ts", "import { UserRole } from '../../../generated/prisma/enums.js';", 0],
  ["bootstrap -> module", "src/app.ts", "import { users } from './modules/users/api/users.js';", 0],
  ["scripts -> module", "src/scripts/scan-due.ts", "import { createUser } from '../modules/users/services/users.service.js';", 0],
  ["api -> repositories", "src/modules/users/api/users.ts", "import { findUser } from '../repositories/users.repository.js';", 1],
  ["api -> db", "src/modules/users/api/users.ts", "import { prisma } from '../../../db/client.js';", 1],
  ["services -> api", "src/modules/users/services/users.service.ts", "import { users } from '../api/users.js';", 1],
  ["services -> db", "src/modules/users/services/users.service.ts", "import { prisma } from '../../../db/client.js';", 1],
  ["repositories -> api", "src/modules/users/repositories/users.repository.ts", "import { users } from '../api/users.js';", 1],
  ["repositories -> services", "src/modules/users/repositories/users.repository.ts", "import { createUser } from '../services/users.service.js';", 1],
  ["schemas -> services", "src/modules/users/schemas/user.schema.ts", "import { createUser } from '../services/users.service.js';", 1],
  ["cross module", "src/modules/users/api/users.ts", "import { bill } from '../../billing/services/billing.service.js';", 1],
  ["shared -> module", "src/shared/http/errors.ts", "import { findUser } from '../../modules/users/repositories/users.repository.js';", 1],
  ["db -> module", "src/db/client.ts", "import { createUser } from '../modules/users/services/users.service.js';", 1],
];

for (const [label, source, statement, expected] of importCases) {
  test(label, () => {
    const root = fixture({ [source]: statement });
    try {
      const result = validate(root);
      assert.equal(result.status, expected, result.output);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

const bypassCases = [
  ["alias cross module", "src/modules/users/api/users.ts", "import { bill } from '@/modules/billing/services/billing.service.js';", "CROSS_MODULE"],
  ["alternative alias cross module", "src/modules/users/api/users.ts", "import { bill } from '~/modules/billing/services/billing.service.js';", "CROSS_MODULE"],
  ["type-only cross module", "src/modules/users/api/users.ts", "import type { bill } from '../../billing/services/billing.service.js';", "CROSS_MODULE"],
  ["re-export cross module", "src/modules/users/api/users.ts", "export { bill } from '../../billing/services/billing.service.js';", "CROSS_MODULE"],
  ["dynamic import cross module", "src/modules/users/api/users.ts", "void import('../../billing/services/billing.service.js');", "CROSS_MODULE"],
  ["require cross module", "src/modules/users/api/users.ts", "require('../../billing/services/billing.service.js');", "CROSS_MODULE"],
  ["require db from api", "src/modules/users/api/users.ts", "require('../../../db/client.js');", "DB_BOUNDARY"],
];

for (const [label, source, statement, code] of bypassCases) {
  test(label, () => {
    const root = fixture({ [source]: statement });
    try {
      const result = validate(root);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, new RegExp(code));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("circular imports fail", () => {
  const root = fixture({
    "src/modules/users/services/users.service.ts": "import { other } from './other.service.js'; export const createUser = other;",
    "src/modules/users/services/other.service.ts": "import { createUser } from './users.service.js'; export const other = createUser;",
  });
  try {
    assert.match(validate(root).output, /CIRCULAR_DEPENDENCY/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing module layer fails", () => {
  const root = fixture();
  try {
    fs.rmSync(path.join(root, "src/modules/users/repositories"), { recursive: true, force: true });
    assert.match(validate(root).output, /MISSING_LAYER/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("module root implementation file fails", () => {
  const root = fixture({ "src/modules/users/users.routes.ts": "export const route = 1;" });
  try {
    assert.match(validate(root).output, /MODULE_ROOT_FILE/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("test directly in tests/unit fails", () => {
  const root = fixture({ "tests/unit/bad.test.ts": "export const bad = 1;" });
  try {
    assert.match(validate(root).output, /TEST_PLACEMENT/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const name of ["users.test.ts", "users.spec.ts"]) {
  test(`${name} under src fails`, () => {
    const root = fixture({ [`src/modules/users/api/${name}`]: "export const bad = 1;" });
    try {
      const result = validate(root);
      assert.equal(result.status, 1, result.output);
      assert.match(result.output, /TEST_IN_SRC/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("symlinked source cannot bypass ownership checks", () => {
  const root = fixture();
  try {
    fs.symlinkSync(
      path.join(root, "src/modules/billing"),
      path.join(root, "src/modules/users/linked-billing"),
      "junction",
    );
    assert.match(validate(root).output, /SYMLINK_SOURCE/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generated source is not validated", () => {
  const root = fixture({
    "src/generated/prisma/seed.ts": "import { createUser } from '../../modules/users/services/users.service.js';",
  });
  try {
    assert.equal(validate(root).status, 0, validate(root).output);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nonliteral dynamic import reports a limitation", () => {
  const root = fixture({
    "src/modules/users/api/users.ts": "const name = 'users.service.js'; void import(name);",
  });
  try {
    const result = validate(root);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /dynamic import expression has no static target/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
