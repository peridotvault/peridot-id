import { Controller, Get, Res } from "@nestjs/common";
import { Response } from "express";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

// The compiled output nests extra dirs (`dist/src/...`), so resolve by
// trying known roots and taking the first that exists (cwd is apps/api).
const SPEC_PATH =
  [
    resolve(process.cwd(), "../../packages/openapi/src/openapi.yaml"),
    resolve(__dirname, "../../../../packages/openapi/src/openapi.yaml"),
  ].find((p) => existsSync(p)) ?? resolve(process.cwd(), "../../packages/openapi/src/openapi.yaml");

@Controller("v1")
export class OpenApiController {
  @Get("openapi.yaml")
  spec(@Res() res: Response): void {
    res.type("application/yaml").send(readFileSync(SPEC_PATH, "utf8"));
  }
}
