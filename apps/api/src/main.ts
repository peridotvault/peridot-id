import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  app.use(cookieParser());
  app.set("trust proxy", 1);
  app.enableCors({
    origin: config.get<string>("CLIENT_SUCCESS_URL", "http://localhost:5173"),
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Peridot ID API")
    .setDescription("Gaming Identity Platform - Authentication, Identity, Profile")
    .setVersion("0.1.0")
    .addCookieAuth("peridot_access")
    .build();
  SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, swaggerConfig));

  await app.listen(config.get<number>("PORT", 3301));
}

void bootstrap();
