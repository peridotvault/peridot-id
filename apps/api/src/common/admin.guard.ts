// Admin-only guard (fail-closed). Role lives on Identity (`user` default);
// the first admin is promoted via documented SQL since no admin exists to do it.
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest() as {
      user?: { pid?: string; app?: string; role?: string };
    };
    const pid = req.user?.pid;
    if (!pid) throw new ForbiddenException("Admin access required");
    // Machine (app) tokens are never admin, even for an admin owner.
    if (req.user?.app) throw new ForbiddenException("Admin access required");
    const identity = await this.prisma.identity.findUnique({
      where: { pid },
      select: { role: true, status: true },
    });
    if (identity?.status === "active" && identity.role === "admin") return true;
    // Testnet keeps only a bare shadow identity (role "user"), so trust the role
    // mainnet just verified during introspection. Only that path sets
    // `user.role`, and mainnet rejects suspended identities before introspecting.
    if (req.user?.role === "admin") return true;
    throw new ForbiddenException("Admin access required");
  }
}
