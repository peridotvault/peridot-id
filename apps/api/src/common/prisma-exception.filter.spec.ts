import { HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaExceptionFilter, Sanitize500Filter } from "./prisma-exception.filter";

function makeHost() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res: unknown = { status, headersSent: false };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: "POST", url: "/v1/session-keys/grants/validate" }),
    }),
  };
  return { host: host as never, status, json };
}

function knownError(code: string, message: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "test" });
}

describe("PrismaExceptionFilter (ANT-285(b))", () => {
  it("maps P2002 to 409 without leaking the constraint", () => {
    const { host, status, json } = makeHost();
    new PrismaExceptionFilter().catch(knownError("P2002", "Unique constraint failed on the constraint `email`"), host);
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({ statusCode: 409, message: "Resource already exists" });
  });

  it("maps P2025 to 404 without leaking the query", () => {
    const { host, status, json } = makeHost();
    new PrismaExceptionFilter().catch(knownError("P2025", "An operation failed because it depends on one or more records that were required but not found."), host);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ statusCode: 404, message: "Resource not found" });
  });

  it("sanitizes unmapped Prisma errors to a generic 500", () => {
    const { host, status, json } = makeHost();
    new PrismaExceptionFilter().catch(knownError("P2034", "super-secret-transaction-detail"), host);
    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toEqual({ statusCode: 500, message: "Internal server error" });
    expect(JSON.stringify(body)).not.toContain("super-secret");
  });
});

describe("Sanitize500Filter (ANT-285(b))", () => {
  it("rethrows non-500 HttpExceptions so Nest serializes them", () => {
    const { host } = makeHost();
    const err = { getStatus: () => 400 };
    expect(() => new Sanitize500Filter().catch(err, host)).toThrow();
  });

  it("sanitizes an unhandled 500 Error without leaking its message", () => {
    const { host, status, json } = makeHost();
    new Sanitize500Filter().catch(new Error("s3cr3t-connection-string postgresql://root:hunter2@db"), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = json.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toEqual({ statusCode: 500, message: "Internal server error" });
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });
});
