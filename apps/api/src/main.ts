import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import { APP_ORIGINS_TTL_MS, isOriginAllowed, parseEnvOrigins } from "./common/cors";
import { PrismaService } from "./prisma/prisma.service";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);

  app.use(cookieParser());
  // DOKU signs the exact raw bytes — keep them for the notify route (req.rawBody).
  app.useBodyParser("json", {
    verify: (req: unknown, _res: unknown, buf: Buffer) => {
      (req as { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  });
  app.set("trust proxy", 1);

  const successUrl = config.get<string>("CLIENT_SUCCESS_URL", "http://localhost:5173");
  const staticOrigins = [successUrl, ...parseEnvOrigins(config.get<string>("CORS_ORIGINS", ""))];
  // Registered third-party apps may call the API from their own origins. Refreshed on a
  // short TTL so newly registered apps work without a redeploy.
  let appOrigins: string[] = [];
  const refreshAppOrigins = async (): Promise<void> => {
    try {
      const prisma = app.get(PrismaService);
      const apps = await prisma.pidApp.findMany({ where: { isActive: true }, select: { allowedOrigins: true } });
      appOrigins = apps.flatMap((a) => a.allowedOrigins);
    } catch {
      // DB unreachable at boot (migrations pending) — env origins only until next refresh.
    }
  };
  await refreshAppOrigins();
  setInterval(() => {
    void refreshAppOrigins();
  }, APP_ORIGINS_TTL_MS);
  app.enableCors({
    origin: (origin, cb) => cb(null, isOriginAllowed(origin, staticOrigins, appOrigins)),
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const swaggerConfig = new DocumentBuilder()
    .setTitle("PeridotID API")
    .setDescription("Gaming Identity Platform - Authentication, Identity, Profile")
    .setVersion("0.1.0")
    .addCookieAuth("pid_access")
    .build();
  SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, swaggerConfig));

  await app.listen(config.get<number>("PORT", 3301));
}

void bootstrap();
