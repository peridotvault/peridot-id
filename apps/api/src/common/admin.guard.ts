// Admin-only guard (fail-closed). Role lives on Identity (`user` default);
// the first admin is promoted via documented SQL since no admin exists to do it.
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest() as { user?: { pid?: string } };
    const pid = req.user?.pid;
    if (!pid) throw new ForbiddenException("Admin access required");
    const identity = await this.prisma.identity.findUnique({
      where: { pid },
      select: { role: true, status: true },
    });
    if (!identity || identity.status !== "active" || identity.role !== "admin") {
      throw new ForbiddenException("Admin access required");
    }
    return true;
  }
}
