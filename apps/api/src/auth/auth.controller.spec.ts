import { BadRequestException } from "@nestjs/common";
import { Request } from "express";
import { AuthController } from "./auth.controller";

/** ANT-387: missing/malformed `handle` on GET /v1/auth/pid/available is a 400, not 200 available:false. */
describe("AuthController.pidAvailable (GET /v1/auth/pid/available)", () => {
  const isPidAvailable = jest.fn();
  const controller = new AuthController(
    { isPidAvailable } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const reqWith = (query: unknown): Request => ({ query } as unknown as Request);

  beforeEach(() => isPidAvailable.mockReset());

  it("400s when handle is missing", async () => {
    await expect(controller.pidAvailable(reqWith({}))).rejects.toThrow(BadRequestException);
    expect(isPidAvailable).not.toHaveBeenCalled();
  });

  it("400s when handle is malformed (too short)", async () => {
    await expect(controller.pidAvailable(reqWith({ handle: "ab" }))).rejects.toThrow(BadRequestException);
    expect(isPidAvailable).not.toHaveBeenCalled();
  });

  it("400s when handle is not a string", async () => {
    await expect(controller.pidAvailable(reqWith({ handle: ["ifal"] }))).rejects.toThrow(BadRequestException);
    expect(isPidAvailable).not.toHaveBeenCalled();
  });

  it("delegates normalized handles to the service", async () => {
    isPidAvailable.mockResolvedValue({ available: true, pid: "ifal@pid" });
    await expect(controller.pidAvailable(reqWith({ handle: "IFAL " }))).resolves.toEqual({
      available: true,
      pid: "ifal@pid",
    });
    expect(isPidAvailable).toHaveBeenCalledWith("ifal");
  });

  it("passes taken handles through as 200 available:false", async () => {
    isPidAvailable.mockResolvedValue({ available: false, pid: null });
    await expect(controller.pidAvailable(reqWith({ handle: "ifal" }))).resolves.toEqual({
      available: false,
      pid: null,
    });
  });
});
