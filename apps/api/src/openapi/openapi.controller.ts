import { Controller, Get, Res } from "@nestjs/common";
import { Response } from "express";
import { readFileSync } from "fs";
import { resolve } from "path";

const SPEC_PATH = resolve(__dirname, "../../../../packages/openapi/src/openapi.yaml");

@Controller("v1")
export class OpenApiController {
  @Get("openapi.yaml")
  spec(@Res() res: Response): void {
    res.type("application/yaml").send(readFileSync(SPEC_PATH, "utf8"));
  }
}
