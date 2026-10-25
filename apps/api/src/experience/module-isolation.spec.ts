import * as fs from "fs";
import * as path from "path";

/**
 * ANT-430 F10 (plan rev 5 §13) — experience/ module isolation.
 *
 * The leveling core must never depend on money-movement or chain code:
 * `experience/` imports nothing from `fiat/`, `wallet/`, or `chain/`.
 * QA grep-verified this manually for M1; this test locks it in so a future
 * import cannot silently couple XP awards to balances or chain state.
 */
describe("experience/ module isolation (F10)", () => {
  const dir = __dirname;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .sort();

  expect(files.length).toBeGreaterThan(0);

  // Static `import … from "…"` / `export … from "…"`, dynamic `import("…")`,
  // and `require("…")` — all with a `../fiat|wallet|chain` target.
  const FORBIDDEN = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']\.\.\/(fiat|wallet|chain)\b/;

  it.each(files)("%s imports nothing from fiat/, wallet/, or chain/", (file) => {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    const hits = src.split("\n").filter((line) => FORBIDDEN.test(line));
    expect(
      hits,
    ).toEqual([]);
  });
});
