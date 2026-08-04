import { ConfigService } from "@nestjs/config";
import { createApp } from "./create-app";

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const config = app.get(ConfigService);
  await app.listen(config.get<number>("PORT", 3301));
}

void bootstrap();
