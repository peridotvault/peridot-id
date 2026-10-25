import { maskEmail, pidLogRef } from "./redact";

// ANT-344 L9: log-safe renderings of PII — raw emails/PIDs never reach logs.
describe("redact", () => {
  it("masks the email local part but keeps the domain greppable", () => {
    expect(maskEmail("ifal@gmail.com")).toBe("i***@gmail.com");
    expect(maskEmail("ab@example.co.id")).toBe("a***@example.co.id");
  });

  it("returns *** for unparseable input", () => {
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskEmail("@")).toBe("***");
    expect(maskEmail("")).toBe("***");
  });

  it("renders a stable non-reversible pid reference", () => {
    const a = pidLogRef("Dev@pid");
    const b = pidLogRef("dev@pid");
    expect(a).toBe(b);
    expect(a).toMatch(/^pid:[0-9a-f]{12}$/);
    expect(a).not.toContain("dev@pid");
    expect(pidLogRef("rani@pid")).not.toBe(a);
  });
});
