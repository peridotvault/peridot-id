import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module";
import { APP_ORIGINS_TTL_MS, isOriginAllowed, staticOriginsFor } from "./common/cors";
import { PrismaService } from "./prisma/prisma.service";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);
  const logger = new Logger("Bootstrap");

  // ANT-227 item 2: the bootstrap-admin env is one-time. While set, the first
  // matching claim mints an admin — remove it right after bootstrap so a
  // leaked/stale value can never matter again.
  if ((config.get<string>("PID_BOOTSTRAP_ADMIN_PID", "") ?? "").trim()) {
    logger.warn(
      "PID_BOOTSTRAP_ADMIN_PID is set: the first matching claim mints an admin. " +
        "Remove this variable immediately after bootstrap.",
    );
  }

  app.use(cookieParser());
  // Secure transport headers (ANT-228). HSTS only in production: emitting it
  // from localhost would poison the dev browser profile (includeSubDomains +
  // localhost HSTS sticks and breaks plain-http dev until expiry).
  const isProd = config.get<string>("NODE_ENV", "development") === "production";
  app.use(
    helmet({
      hsts: isProd ? undefined : false,
      // The wallet posts cross-origin to the API with credentials; COOP/COEP
      // defaults stay off so popup/OAuth flows keep working.
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: false,
    }),
  );
  // DOKU signs the exact raw bytes — keep them for the notify route (req.rawBody).
  app.useBodyParser("json", {
    verify: (req: unknown, _res: unknown, buf: Buffer) => {
      (req as { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  });
  app.set("trust proxy", 1);

  const staticOrigins = staticOriginsFor(config);
  // Credentialed CORS is first-party + VERIFIED apps only (ANT-228). Any
  // self-serve registered app still gets redirect/code delivery via
  // resolveReturnTo (SSO codes ride the redirect URL server-to-server, no
  // cookie sharing) — but only operator-verified partners may read identity
  // data cross-origin with `credentials: include`. Unverified origins stay
  // out of the credentialed allowlist even though their redirects work.
  let appOrigins: string[] = [];
  const refreshAppOrigins = async (): Promise<void> => {
    try {
      const prisma = app.get(PrismaService);
      const apps = await prisma.pidApp.findMany({ where: { isActive: true, isVerified: true }, select: { allowedOrigins: true } });
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

  await app.listen(config.get<number>("PORT", 3300));
}

void bootstrap();
