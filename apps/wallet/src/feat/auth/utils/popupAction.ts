import type { PeridotClient } from "@peridotvault/pid-sdk-js";

const LAMPORTS_PER_SOL = 1e9;

function reqStr(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || !v) throw new Error(`Missing "${key}"`);
  return v;
}

function fmtAmount(amount: string, asset: string): string {
  if (asset !== "SOL") return `${amount} (raw units of ${asset})`;
  const sol = Number(BigInt(amount)) / LAMPORTS_PER_SOL;
  return `${sol} SOL`;
}

/** Human summary of the intent the user is about to sign. */
export function summarize(action: string, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (action) {
    case "withdraw":
      return `Send ${fmtAmount(reqStr(p, "amount"), String(p.asset ?? "SOL"))} to ${reqStr(p, "to")}`;
    case "execute":
      return `Approve a smart-account action on program ${reqStr(p, "target")}`;
    case "topup":
      return `Deposit ${fmtAmount(reqStr(p, "amount"), String(p.asset ?? "SOL"))} into your smart account`;
    case "activate":
      return "Activate your smart account on-chain (one-time)";
    case "rotate":
      return "Replace this wallet's passkey authority with the registered replacement";
    case "register":
      return "Register a new passkey on this wallet";
    default:
      throw new Error(`Unknown action "${action}"`);
  }
}

export async function runAction(peridot: PeridotClient, action: string, payload: unknown): Promise<unknown> {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (action) {
    case "withdraw":
      return peridot.wallet.withdraw({ amount: reqStr(p, "amount"), asset: String(p.asset ?? "SOL"), to: reqStr(p, "to") });
    case "execute":
      return peridot.wallet.execute({
        target: reqStr(p, "target"),
        metas: Array.isArray(p.metas) ? (p.metas as { address: string; writable: boolean; signer: boolean }[]) : [],
        data: reqStr(p, "data"),
      });
    case "topup":
      return peridot.wallet.topup({ amount: reqStr(p, "amount"), asset: String(p.asset ?? "SOL") });
    case "activate":
      return peridot.wallet.activate();
    case "rotate":
      return peridot.wallet.rotate({ oldCredentialId: typeof p.oldCredentialId === "string" ? p.oldCredentialId : undefined, newCredentialId: reqStr(p, "newCredentialId") });
    case "register":
      return peridot.passkey.register();
    default:
      throw new Error(`Unknown action "${action}"`);
  }
}

export function isFiatAction(action: string): boolean {
  return action === "fiat-transfer" || action === "fiat-checkout";
}

/** A 401/expired-session error, as opposed to a real business failure. */
export function isSessionError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /401|unauthorized|not registered|not signed in|session/i.test(message);
}

/** Map a session error to actionable copy; anything else stays verbatim. */
export function signInHint(e: unknown): string {
  if (isSessionError(e)) {
    return "Sign in to your PeridotID wallet in this window first, then ask the app to retry.";
  }
  return e instanceof Error ? e.message : String(e);
}
