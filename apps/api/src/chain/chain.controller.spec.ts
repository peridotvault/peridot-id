import { ChainController } from "./chain.controller";

// ANT-75: the presence-signal endpoint is a thin pass-through over
// ChainRegistryService.solanaMainnetAvailability (the single source of
// truth). These tests pin the contract shape the wallet (ANT-73) consumes.
describe("ChainController.solanaAvailability", () => {
  function controller(availability: unknown) {
    const chains = { solanaMainnetAvailability: jest.fn(async () => availability) };
    return { controller: new ChainController(chains as never), chains };
  }

  it("returns the unavailable shape while no mainnet program exists", async () => {
    const { controller: c, chains } = controller({
      available: false,
      reference: null,
      program: null,
      rpcUrl: null,
    });
    await expect(c.solanaAvailability()).resolves.toEqual({
      available: false,
      reference: null,
      program: null,
      rpcUrl: null,
    });
    expect(chains.solanaMainnetAvailability).toHaveBeenCalledTimes(1);
  });

  it("passes the available shape through unchanged when a mainnet program ships", async () => {
    const { controller: c } = controller({
      available: true,
      reference: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      program: "Mainnet1111111111111111111111111111111111111",
      rpcUrl: "https://api.mainnet-beta.solana.com",
    });
    await expect(c.solanaAvailability()).resolves.toEqual({
      available: true,
      reference: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      program: "Mainnet1111111111111111111111111111111111111",
      rpcUrl: "https://api.mainnet-beta.solana.com",
    });
  });
});
