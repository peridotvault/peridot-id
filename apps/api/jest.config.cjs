/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
  testEnvironment: "node",
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^@peridotvault/pid-types$": "<rootDir>/../../packages/types/src",
    "^@peridotvault/pid-solana$": "<rootDir>/../../packages/solana/src",
    "^@peridotvault/pid-payments$": "<rootDir>/../../packages/payments/src",
    "^@peridotvault/pid-evm$": "<rootDir>/../../packages/evm/src",
    "^@peridotvault/pid-core$": "<rootDir>/../../packages/core/src",
    "^@peridotvault/pid-core/dist/(.*)$": "<rootDir>/../../packages/core/src/$1",
  },
};
