// Production BatchPorts binding (ANT-767 scope expansion).
//
// Replaces the fail-closed default with real chain transport once the
// operator provisions it (see Trevor's ANT-771 answers):
//   - Monad testnet RPC URL: chain-registry row eip155:10143 `rpcUrls[0]`
//     via ChainRegistryService.rpcUrlForReference (dev fallback localhost).
//   - EVM relayer key: dashboard-managed `evm_relayer_keys` row per chain
//     via relayerSecretFor (decrypted server-side with PID_SECRETS_ENC_KEY).
//   - Flush driver: external cron calling POST /flush with an admin user JWT.
// Unset relayer/registry rows fail closed (503) — same observable behavior
// as the old failClosedPorts default, but live when configured.
//
// Design (Troy's ANT-770 envelope spec v1): the queue stores each op's intent
// opaque; the submitter forwards it VERBATIM through the EXISTING single-call
// EVM entrypoint — sequential, one tx per op, no multicall, never re-signed.
// The tx goes TO the envelope `account` (the smart account) with the stored
// op `data` (the already-signed execute/executeWithPermission calldata).
// Kind-aware validation + call-mirrors-op cross-checks live in
// batch-queue.service.ts (validateIntentEnvelope, enforced at the boundary).
import { ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EvmRpc } from "@peridotvault/pid-evm";
import { ChainRegistryService } from "../chain/chain-registry.service";
import {
  BatchPorts,
  DEFAULT_BATCH_REFERENCE,
  OpReceipt,
  batchError,
  validateIntentEnvelope,
} from "./batch-queue.service";

/** 1 gwei fallback when the node hides the gas price (evm-activation precedent). */
const FALLBACK_GAS_PRICE_WEI = 1_000_000_000n;

/** OP-Stack L1 oracle (absent on Monad testnet — best-effort, 0n fallback). */
const L1_GAS_ORACLE = "0x420000000000000000000000000000000000000F";
const L1_FEE_SELECTOR = "49904e67"; // getL1Fee(bytes)

/** `getPermission(bytes32)` selector (verified via viem toFunctionSelector). */
const GET_PERMISSION_SELECTOR = "0x33d33167";

async function rpcFor(chains: ChainRegistryService, reference: string): Promise<{ rpc: EvmRpc; url: string }> {
  const url = await chains.rpcUrlForReference(reference);
  return { rpc: new EvmRpc(url), url };
}

async function relayerSecretFor(chains: ChainRegistryService, reference: string): Promise<`0x${string}`> {
  const secret = await chains.relayerSecretFor(reference);
  if (!secret || !/^0x[0-9a-fA-F]{64}$/.test(secret)) {
    throw new ServiceUnavailableException(`Batch relayer is not configured for chain ${reference}`);
  }
  return secret as `0x${string}`;
}

/** L1 data fee for a confirmed tx via the OP-Stack oracle (best-effort: 0n). */
async function l1DataFeeWei(rpc: EvmRpc, txHash: string): Promise<bigint> {
  try {
    const tx = await rpc.call<{ input?: string }>("eth_getTransactionByHash", [txHash]);
    if (!tx || typeof tx.input !== "string" || tx.input === "0x" || tx.input === "") return 0n;
    const input = tx.input.startsWith("0x") ? tx.input.slice(2) : tx.input;
    const lenHex = input.length / 2;
    const paddedLen = Math.ceil(lenHex / 32) * 32;
    const call =
      `0x${L1_FEE_SELECTOR}` +
      `0000000000000000000000000000000000000000000000000000000000000020` +
      lenHex.toString(16).padStart(64, "0") +
      input.padEnd(paddedLen * 2, "0");
    const res = await rpc.call<string>("eth_call", [{ to: L1_GAS_ORACLE, data: call }, "latest"]);
    return BigInt(res);
  } catch {
    return 0n;
  }
}

/**
 * Production ports factory. Captures the batch chain reference from config
 * (BATCH_CHAIN_REFERENCE, default Monad testnet 10143) and builds
 * per-call RPC/relayer clients — no module-level chain state.
 */
export function productionBatchPorts(chains: ChainRegistryService, config: ConfigService): BatchPorts {
  const reference = config.get<string>("BATCH_CHAIN_REFERENCE") ?? DEFAULT_BATCH_REFERENCE;

  return {
    estimator: {
      estimateNetworkCost: async (op) => {
        const env = validateIntentEnvelope(op.intent, op);
        if (env.chainId !== reference) {
          throw batchError("INVALID_CALLDATA", "Intent chainId does not match the batch chain");
        }
        // Relayer first: fail closed before any RPC/DB reads beyond config.
        const secret = await relayerSecretFor(chains, reference);
        const { rpc, url } = await rpcFor(chains, reference);
        void url;
        const { privateKeyToAccount } = (await import("viem/accounts")) as typeof import("viem/accounts");
        const from = privateKeyToAccount(secret).address;
        const gas = await rpc.call<string>("eth_estimateGas", [{ from, to: env.account, data: op.data }, "latest"]);
        const price = await rpc.gasPrice().catch(() => FALLBACK_GAS_PRICE_WEI);
        return BigInt(gas) * price;
      },
    },

    simulator: {
      simulate: async (op) => {
        const env = validateIntentEnvelope(op.intent, op);
        if (env.chainId !== reference) {
          return { ok: false, reason: "SIMULATION_FAILED: Intent chainId does not match the batch chain", gasEstimate: 0n };
        }
        const { rpc } = await rpcFor(chains, reference);
        // Config errors (relayer unset) throw loud; execution reverts
        // return ok:false so the batch records a per-op failure.
        const secret = await relayerSecretFor(chains, reference);
        const { privateKeyToAccount } = (await import("viem/accounts")) as typeof import("viem/accounts");
        const from = privateKeyToAccount(secret).address;
        try {
          await rpc.call<string>("eth_call", [{ from, to: env.account, data: op.data }, "latest"]);
        } catch (err) {
          return {
            ok: false,
            reason: `SIMULATION_FAILED: ${err instanceof Error ? err.message : String(err)}`,
            gasEstimate: 0n,
          };
        }
        const gas = await rpc
          .call<string>("eth_estimateGas", [{ from, to: env.account, data: op.data }, "latest"])
          .catch(() => "0x0");
        return { ok: true, gasEstimate: BigInt(gas) };
      },
    },

    submitter: {
      submit: async (op): Promise<OpReceipt> => {
        const env = validateIntentEnvelope(op.intent, op);
        if (env.chainId !== reference) {
          throw batchError("INVALID_CALLDATA", "Intent chainId does not match the batch chain");
        }
        const chainIdNum = Number(reference);
        if (!Number.isInteger(chainIdNum)) {
          throw new ServiceUnavailableException("Unsupported EVM batch chain");
        }
        const { rpc, url } = await rpcFor(chains, reference);
        const secret = await relayerSecretFor(chains, reference);
        // Lazy viem import (keeps the ESM graph out of Jest unless a send runs).
        const viem = (await import("viem")) as typeof import("viem");
        const { privateKeyToAccount } = (await import("viem/accounts")) as typeof import("viem/accounts");
        const account = privateKeyToAccount(secret);
        const row = await chains.chainByReference(reference).catch(() => undefined);
        const publicClient = viem.createPublicClient({ transport: viem.http(url) });
        const walletClient = viem.createWalletClient({
          account,
          chain: {
            id: chainIdNum,
            name: row?.name ?? `eip155:${reference}`,
            nativeCurrency: { name: row?.nativeSymbol ?? "MON", symbol: row?.nativeSymbol ?? "MON", decimals: row?.decimals ?? 18 },
            rpcUrls: { default: { http: [url] } },
          },
          transport: viem.http(url),
        });
        const gas = op.gasLimit !== undefined
          ? BigInt(op.gasLimit)
          : await publicClient.estimateGas({
            account,
            to: env.account as `0x${string}`,
            data: op.data as `0x${string}`,
          });
        let hash: `0x${string}`;
        try {
          hash = await walletClient.sendTransaction({
            to: env.account as `0x${string}`,
            data: op.data as `0x${string}`,
            value: 0n,
            gas,
          });
        } catch (err) {
          return {
            txHash: "",
            gasUsed: 0n,
            effectiveGasPrice: 0n,
            ok: false,
            revertReason: `RELAYER_ERROR: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const gasPrice = receipt.effectiveGasPrice ?? 0n;
        const l1Fee = await l1DataFeeWei(rpc, hash);
        if (receipt.status !== "success") {
          return {
            txHash: hash,
            gasUsed: receipt.gasUsed,
            effectiveGasPrice: gasPrice,
            l1Fee,
            ok: false,
            revertReason: "EXECUTION_REVERTED",
          };
        }
        return { txHash: hash, gasUsed: receipt.gasUsed, effectiveGasPrice: gasPrice, l1Fee, ok: true };
      },
    },

    sessions: {
      check: async ({ nowSec, account, permissionId }) => {
        // No grant reference on a session batch: fail closed (never valid).
        if (!account || !permissionId) {
          return { valid: false, revoked: true, expiresAt: 0 };
        }
        const { rpc } = await rpcFor(chains, reference);
        const data = `${GET_PERMISSION_SELECTOR}${permissionId.slice(2)}`;
        let raw: string;
        try {
          raw = await rpc.call<string>("eth_call", [{ to: account, data }, "latest"]);
        } catch {
          // Chain unreadable: throw so submit 503s (never void quotes) and
          // settlement catches fail-closed to revoked (never settle blind).
          throw new ServiceUnavailableException("Batch session validation is not reachable");
        }
        const words = (raw.startsWith("0x") ? raw.slice(2) : raw).toLowerCase();
        // Permission struct: 17 words; all-zero / short = no grant on-chain.
        if (words.length < 17 * 64 || /^0+$/.test(words)) {
          return { valid: false, revoked: true, expiresAt: 0 };
        }
        const w = (i: number): bigint => BigInt(`0x${words.slice(i * 64, (i + 1) * 64)}`);
        const validAfter = w(2);
        const validUntil = w(3);
        const revoked = w(6) !== 0n;
        const valid = !revoked && validAfter <= BigInt(nowSec) && BigInt(nowSec) <= validUntil;
        const expiresAt = validUntil <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(validUntil) : Number.MAX_SAFE_INTEGER;
        return { valid, revoked, expiresAt };
      },
    },
  };
}
