// Public fee-policy endpoint wiring (ANT-730, AC-18; ANT-743 pure percentage):
// thin delegation to the service view — no auth, no shaping in the controller.
import { FeePolicyController } from "./fee-policy.controller";

describe("FeePolicyController", () => {
  it("serves the active policy view publicly", async () => {
    const view = {
      version: 2,
      bps: 5000,
      minFee: {},
      fxSource: "CoinGecko USD/IDR",
      fxAsOf: "2026-10-27T00:00:00.000Z",
      updatedAt: "2026-10-27T00:00:00.000Z",
    };
    const fees = { publicView: jest.fn(async () => view) };
    const controller = new FeePolicyController(fees as never);
    await expect(controller.get()).resolves.toBe(view);
    expect(fees.publicView).toHaveBeenCalledTimes(1);
  });
});
