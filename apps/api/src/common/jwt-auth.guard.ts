import { Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Request } from "express";
import { ACCESS_COOKIE } from "./cookies";

const cookieExtractor = (req: Request): string | null => {
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[ACCESS_COOKIE];
  return cookie ?? null;
};

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor() {
    super({});
  }
}

export { cookieExtractor };
