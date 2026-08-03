import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { Request, Response } from "express";
import { LoginResponse } from "@peridot/types";
import { AuthService } from "./auth.service";
import { GoogleGuard } from "./google.guard";

@Controller("v1/auth")
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  login(@Req() req: Request): LoginResponse {
    const base = `${req.protocol}://${req.get("host")}`;
    return { url: `${base}/v1/auth/google` };
  }

  @Get("google")
  @UseGuards(GoogleGuard)
  google(): void {
    // passport redirects to Google
  }

  @Get("google/callback")
  @UseGuards(GoogleGuard)
  async googleCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const identity = req.user as { id: string };
    await this.authService.issueSession(res, identity.id, req.headers["user-agent"]);
    res.redirect(this.config.get<string>("CLIENT_SUCCESS_URL", "/"));
  }

  @Post("refresh")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.authService.rotateSession(req, res);
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.authService.logout(req, res);
  }
}
