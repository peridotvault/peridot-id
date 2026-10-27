// Admin fee-policy DTO boundary validation (ANT-741, Tobias LOW #2).
// Boundary shapes enforced by the global ValidationPipe: bps 1..5000,
// minima 1..64 legs, known namespaces. Duplicates are a service-level 400
// (DuplicateChainMin) covered in fee-policy.service.spec.
import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateFeePolicyDto } from "./admin.dto";

function leg(overrides: Record<string, unknown> = {}) {
  return { namespace: "eip155", reference: "84532", minFee: "750000000000", ...overrides };
}

async function errorsFor(payload: Record<string, unknown>) {
  return validate(plainToInstance(CreateFeePolicyDto, payload), { whitelist: true });
}

describe("CreateFeePolicyDto boundaries", () => {
  it("rejects bps=0 (no zero-fee policy without review)", async () => {
    expect(await errorsFor({ bps: 0, minima: [leg()] })).not.toHaveLength(0);
  });

  it("rejects bps above the protocol max", async () => {
    expect(await errorsFor({ bps: 5001, minima: [leg()] })).not.toHaveLength(0);
  });

  it("accepts bps=1 with one leg", async () => {
    expect(await errorsFor({ bps: 1, minima: [leg()] })).toHaveLength(0);
  });

  it("rejects an empty minima array", async () => {
    expect(await errorsFor({ bps: 100, minima: [] })).not.toHaveLength(0);
  });

  it("rejects more than 64 minima legs", async () => {
    const minima = Array.from({ length: 65 }, (_, i) => leg({ reference: String(1000 + i) }));
    expect(await errorsFor({ bps: 100, minima })).not.toHaveLength(0);
  });

  it("accepts the stellar namespace (seed parity)", async () => {
    const errors = await errorsFor({ bps: 100, minima: [leg({ namespace: "stellar", reference: "testnet" })] });
    expect(errors).toHaveLength(0);
  });

  it("rejects an unknown namespace", async () => {
    expect(await errorsFor({ bps: 100, minima: [leg({ namespace: "sui" })] })).not.toHaveLength(0);
  });
});
