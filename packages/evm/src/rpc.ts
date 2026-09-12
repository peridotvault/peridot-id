// Minimal EVM JSON-RPC client (mirrors SolanaRpc failover shape, ADR 007 §8).
// Plain fetch — no viem/ethers. Reads only in phase 1 (balance/code); the
// relayer deploys via the forge script until the API signer lands.

export interface EvmRpcLike {
  getBalance(address: string): Promise<bigint>;
  getCode(address: string): Promise<string>;
  chainId(): Promise<number>;
  gasPrice(): Promise<bigint>;
  call(method: string, params: unknown[]): Promise<unknown>;
}

export class EvmRpc implements EvmRpcLike {
  private readonly endpoints: string[];
  private current = 0;

  constructor(endpoints: string | string[]) {
    const urls = typeof endpoints === "string" ? [endpoints] : endpoints;
    if (urls.length === 0) throw new Error("at least one RPC endpoint required");
    this.endpoints = urls;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastErr: unknown = null;
    for (let i = 0; i < this.endpoints.length; i++) {
      const url = this.endpoints[(this.current + i) % this.endpoints.length];
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (!res.ok) throw new Error(`rpc http ${res.status}`);
        const json = (await res.json()) as { result?: T; error?: { message: string } };
        if (json.error) throw new Error(`rpc: ${json.error.message}`);
        this.current = this.endpoints.indexOf(url);
        return json.result as T;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("evm rpc failed");
  }

  async getBalance(address: string): Promise<bigint> {
    const hex = await this.call<string>("eth_getBalance", [address, "latest"]);
    return BigInt(hex);
  }

  async getCode(address: string): Promise<string> {
    return this.call<string>("eth_getCode", [address, "latest"]);
  }

  async chainId(): Promise<number> {
    const hex = await this.call<string>("eth_chainId", []);
    return Number(BigInt(hex));
  }

  async gasPrice(): Promise<bigint> {
    return BigInt(await this.call<string>("eth_gasPrice", []));
  }
}
