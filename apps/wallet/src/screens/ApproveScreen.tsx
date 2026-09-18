// Popup approval screen (web only). A third-party dapp opened this page via the
// SDK popup bridge (`?popup=<action>&origin=…`). The request arrives over the
// validated postMessage handshake — never trust the URL alone. On approve, the
// action runs here on the PeridotID origin with this session + passkey (the
// trusted DOM), and the result is posted back to the opener's origin.
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  awaitPopupRequest,
  postPopupReady,
  postPopupResult,
  type PeridotClient,
  type PopupParams,
} from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../AppContext";
import { styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

const LAMPORTS_PER_SOL = 1e9;

type Phase = "waiting" | "review" | "busy" | "done" | "failed";

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
function summarize(action: string, payload: unknown): string {
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

async function runAction(peridot: PeridotClient, action: string, payload: unknown): Promise<unknown> {
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

export function ApproveScreen({ popup }: { popup: PopupParams }) {
  const { peridot } = usePeridot();
  const [phase, setPhase] = useState<Phase>("waiting");
  const [action, setAction] = useState(popup.action);
  const [payload, setPayload] = useState<unknown>(undefined);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        postPopupReady(popup.origin);
        const req = await awaitPopupRequest(popup.origin);
        if (cancelled) return;
        setAction(req.action);
        setPayload(req.payload);
        setSummary(summarize(req.action, req.payload));
        setPhase("review");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [popup.origin]);

  const deny = useCallback(() => {
    postPopupResult(popup.origin, { ok: false, error: "access_denied" });
    setPhase("done");
  }, [popup.origin]);

  const approve = useCallback(async () => {
    setPhase("busy");
    setError(null);
    try {
      const result = await runAction(peridot, action, payload);
      postPopupResult(popup.origin, { ok: true, data: result });
      setPhase("done");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      try {
        postPopupResult(popup.origin, { ok: false, error: message });
      } catch {
        // opener gone — show it here instead
      }
      setError(message);
      setPhase("review");
    }
  }, [peridot, action, payload, popup.origin]);

  return (
    <View style={s.container}>
      <Text style={s.title}>Approve request</Text>
      {phase === "waiting" && <Text style={s.hint}>Waiting for the app…</Text>}
      {phase === "done" && <Text style={s.hint}>Done — you can close this window.</Text>}
      {(phase === "review" || phase === "busy") && summary && (
        <>
          <Text style={s.label}>Requested action</Text>
          <Text selectable style={s.mono}>{summary}</Text>
          <Text style={s.hint}>Review carefully — approving signs with your passkey.</Text>
        </>
      )}
      {error && <Text style={s.error}>{error}</Text>}
      {(phase === "review" || phase === "busy") && (
        <>
          <UIButton title={phase === "busy" ? "Waiting for passkey…" : "Approve"} onPress={approve} disabled={phase === "busy"} variant="primary" />
          <UIButton title="Deny" onPress={deny} disabled={phase === "busy"} />
        </>
      )}
    </View>
  );
}
