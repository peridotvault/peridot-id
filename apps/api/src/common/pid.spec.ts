import { PID_HANDLE_REGEX, PID_REGEX, isPid, isPidHandle, normalizePidHandle, toPid } from "./pid";

describe("normalizePidHandle", () => {
  it("lowercases and trims", () => {
    expect(normalizePidHandle("  Ifal ")).toBe("ifal");
  });
});

describe("toPid / isPid", () => {
  it("builds the permanent handle@pid identity", () => {
    expect(toPid("ifal")).toBe("ifal@pid");
    expect(toPid("IFAL")).toBe("ifal@pid");
  });

  it("rejects invalid handles", () => {
    expect(() => toPid("ab")).toThrow("Invalid PID handle");
    expect(() => toPid("has-dash")).toThrow("Invalid PID handle");
    expect(() => toPid("has space")).toThrow("Invalid PID handle");
  });

  it("validates full PIDs and legacy formats", () => {
    expect(isPid("ifal@pid")).toBe(true);
    expect(isPid("pid_01K4Y4DWMK7YSH8X4JQY9M4T6P")).toBe(false);
    expect(isPid("IFAL@pid")).toBe(false);
    expect(isPidHandle("ifal")).toBe(true);
    expect(isPidHandle("ab")).toBe(false);
    expect(PID_HANDLE_REGEX.test("ranaufal")).toBe(true);
    expect(PID_REGEX.test("ranaufal@pid")).toBe(true);
  });
});
