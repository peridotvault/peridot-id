import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Response } from "express";

/**
 * Global Prisma → HTTP mapping (ANT-285(b)).
 *
 * - P2002 (unique violation, e.g. concurrent idempotent create) → 409 Conflict.
 * - P2025 (record not found, e.g. findUniqueOrThrow) → 404 Not Found.
 * - Anything else reaching the filter → 500 with a sanitized body: the cause
 *   stays server-side (log), the client gets a generic message. Failure-closed,
 *   no Prisma codes / constraint names / stack traces leak (Information
 *   disclosure, OWASP API Top 10 Security Misconfiguration).
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception.code === "P2002") {
      res.status(HttpStatus.CONFLICT).json({ statusCode: 409, message: "Resource already exists" });
      return;
    }
    if (exception.code === "P2025") {
      res.status(HttpStatus.NOT_FOUND).json({ statusCode: 404, message: "Resource not found" });
      return;
    }
    this.logger.error(`unmapped Prisma error ${exception.code}: ${exception.message.slice(0, 200)}`);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, message: "Internal server error" });
  }
}

/**
 * Last-resort 500 sanitizer (ANT-285(b)). Nest's default 500 body for an
 * unhandled Error is already `{ statusCode: 500, message: "Internal server
 * error" }`, but a thrown object with a custom message (or a library error
 * surfaced as 500) can leak internals. This catch-all guarantees the wire
 * body never carries more than the generic message while the real cause is
 * logged server-side with reconstruction context (method + url).
 */
@Catch()
export class Sanitize500Filter implements ExceptionFilter {
  private readonly logger = new Logger(Sanitize500Filter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    // HttpExceptions (4xx from guards/pipes/services) already carry safe,
    // deliberate messages — rethrow so Nest's built-in serializer handles them.
    if (exception !== null && typeof exception === "object" && "getStatus" in exception) {
      const status = (exception as { getStatus: () => number }).getStatus();
      if (status !== HttpStatus.INTERNAL_SERVER_ERROR) throw exception;
    }
    const req = ctx.getRequest<{ method?: string; url?: string }>();
    const detail = exception instanceof Error ? exception.message.slice(0, 200) : String(exception).slice(0, 200);
    this.logger.error(`${req.method ?? "?"} ${req.url ?? "?"} unhandled: ${detail}`);
    if (res.headersSent) return;
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, message: "Internal server error" });
  }
}
