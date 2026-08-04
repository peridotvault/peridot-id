import { NestExpressApplication } from "@nestjs/platform-express";
import { createApp } from "./create-app";

let app: NestExpressApplication | undefined;

export default async function handler(req: unknown, res: unknown): Promise<void> {
  if (!app) app = await createApp();
  const instance = app.getHttpAdapter().getInstance() as (req: unknown, res: unknown) => void;
  instance(req, res);
}
