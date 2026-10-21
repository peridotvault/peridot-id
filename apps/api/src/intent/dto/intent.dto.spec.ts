import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateIntentDto } from "./intent.dto";

// ANT-344 L4: CreateIntentDto.payload carries @ValidateNested + @Type so the
// IntentPayloadDto rules (digit-only amount, base58 destination/mint) actually
// run. Without them any object passed validation silently.
describe("CreateIntentDto nested payload validation", () => {
  async function errorsFor(payload: unknown) {
    const dto = plainToInstance(CreateIntentDto, { type: "WITHDRAW_SOL", payload });
    return validate(dto, { whitelist: true });
  }

  it("rejects a non-numeric amount in the nested payload", async () => {
    const errors = await errorsFor({ amount: "abc" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects an invalid base58 destination in the nested payload", async () => {
    const errors = await errorsFor({ amount: "100", destination: "not-a-key!!!" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("accepts a well-formed nested payload", async () => {
    const errors = await errorsFor({ amount: "100" });
    expect(errors).toHaveLength(0);
  });
});
