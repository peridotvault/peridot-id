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
    "^@peridotvault/pid-types$": "<rootDir>/../../packages/types/src",
  },
};
