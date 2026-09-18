import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Peridot } from "@peridotvault/pid-sdk-js";
import type { ApiError, ExchangeResult, PeridotClient } from "@peridotvault/pid-sdk-js";
import { forwardPopupLoginCode, openLoginPopup, PopupBlockedError } from "@peridotvault/pid-sdk-js";
import { PeridotLoginModal } from "./modal.js";
import type { LoginMethod, PeridotProviderProps, UsePeridotApi } from "./types.js";

export const PROD_BASE_URL = "https://api.pid.peridotvault.com";
export const HOSTED_LOGIN_URL = "https://app.pid.peridotvault.com";
const DEFAULT_SOLANA_RPC = "https://api.devnet.solana.com";

function isApiError(v: ExchangeResult | ApiError): v is ApiError {
  return typeof v === "object" && v !== null && "statusCode" in v;
}

function readPidCode(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get("pid_code");
  } catch {
    return null;
  }
}

function stripPidCode(): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("pid_code")) return;
    url.searchParams.delete("pid_code");
    window.history.replaceState({}, "", url.toString());
  } catch {
    // non-fatal
  }
}

const PeridotContext = createContext<UsePeridotApi | null>(null);

export function usePeridot(): UsePeridotApi {
  const ctx = useContext(PeridotContext);
  if (!ctx) throw new Error("usePeridot must be used within a PeridotProvider");
  return ctx;
}

export function PeridotProvider({
  children,
  baseUrl,
  clientId,
  redirectUri,
  hostedLoginUrl,
  solanaRpcUrl,
  methods = ["google", "passkey"],
  onExchange,
  onSuccess,
  onError,
}: PeridotProviderProps & { children: ReactNode }) {
  const clientRef = useRef<PeridotClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = Peridot({
      baseUrl: baseUrl ?? PROD_BASE_URL,
      solanaRpcUrl: solanaRpcUrl ?? DEFAULT_SOLANA_RPC,
      popupBaseUrl: hostedLoginUrl ?? HOSTED_LOGIN_URL,
    });
  }
  const client = clientRef.current;

  const [user, setUser] = useState<ExchangeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [busyMethod, setBusyMethod] = useState<LoginMethod | null>(null);

  const returnTo = useMemo(() => {
    if (redirectUri) return redirectUri;
    return typeof window !== "undefined" ? window.location.origin : "";
  }, [redirectUri]);

  const fail = useCallback(
    (err: unknown) => {
      const message = err instanceof Error ? err.message : "Sign-in failed — try again.";
      setError(message);
      onError?.(err);
    },
    [onError],
  );

  const doExchange = useCallback(
    async (code: string) => {
      if (onExchange) {
        await onExchange(code);
        onSuccess?.(null);
        return;
      }
      const res = await client.auth.exchange(code, clientId);
      if (isApiError(res)) {
        const message = Array.isArray(res.message) ? res.message.join("; ") : res.message;
        throw new Error(message || "Sign-in failed — try again.");
      }
      setUser(res);
      onSuccess?.(res);
    },
    [client, clientId, onExchange, onSuccess],
  );

  // Returning from PeridotID with ?pid_code= — exchange once, then clean the URL.
  // Inside a login popup (OAuth redirect landed on the dapp URL in the popup),
  // forward the code to the opener instead and close.
  useEffect(() => {
    const code = readPidCode();
    if (!code) return;
    if (typeof window !== "undefined" && window.opener && forwardPopupLoginCode()) return;
    let cancelled = false;
    setLoading(true);
    doExchange(code)
      .then(() => {
        if (!cancelled) stripPidCode();
      })
      .catch((err) => {
        if (!cancelled) fail(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [doExchange, fail]);

  const openLogin = useCallback(() => {
    setError(null);
    setModalOpen(true);
  }, []);
  const closeLogin = useCallback(() => {
    if (busyMethod) return;
    setModalOpen(false);
  }, [busyMethod]);

  /**
   * All login ceremonies run on the hosted PeridotID page inside a popup, so the
   * browser address bar stays visible as the trust signal and the dapp keeps its
   * state. Google OAuth needs the redirect round-trip and WebAuthn legally
   * requires a PeridotID origin (rpId), so no ceremony can run in-page on a
   * third-party site. The popup returns with ?pid_code=, which is exchanged
   * here. Pure navigation fallback when popups are blocked: no API calls, no
   * CORS involved.
   */
  const openPopupLogin = useCallback(
    async (method: LoginMethod) => {
      if (typeof window === "undefined") return;
      const popupBase = hostedLoginUrl ?? HOSTED_LOGIN_URL;
      const selfOrigin = window.location.origin;
      const params: Record<string, string> = {
        redirect_uri: returnTo || selfOrigin,
        origin: selfOrigin,
        popup: "login",
        method,
      };
      if (clientId) params.client_id = clientId;
      setError(null);
      setBusyMethod(method);
      try {
        const { pidCode } = await openLoginPopup({ popupBaseUrl: popupBase, params });
        setModalOpen(false);
        if (!pidCode) throw new Error("Sign-in failed — try again.");
        await doExchange(pidCode);
      } catch (err) {
        if (err instanceof PopupBlockedError) {
          // Fall back to the honest full-page round-trip (address bar is real,
          // the SPA just loses its state).
          const fallback = new URLSearchParams({ redirect_uri: returnTo || selfOrigin });
          if (clientId) fallback.set("client_id", clientId);
          window.location.assign(`${popupBase}?${fallback.toString()}`);
          return;
        }
        fail(err);
      } finally {
        setBusyMethod(null);
      }
    },
    [returnTo, clientId, hostedLoginUrl, doExchange, fail],
  );

  const handleGoogle = useCallback(() => {
    void openPopupLogin("google");
  }, [openPopupLogin]);

  const handlePasskey = useCallback(() => {
    // No secure-context guard: the ceremony runs in the popup on the PeridotID
    // origin, never on this page — any http(s) dapp can offer it.
    void openPopupLogin("passkey");
  }, [openPopupLogin]);

  const logout = useCallback(async () => {
    await client.auth.logout();
    setUser(null);
  }, [client]);

  const value = useMemo<UsePeridotApi>(
    () => ({ user, loading, error, openLogin, closeLogin, logout, client }),
    [user, loading, error, openLogin, closeLogin, logout, client],
  );

  return (
    <PeridotContext.Provider value={value}>
      {children}
      <PeridotLoginModal
        open={modalOpen}
        methods={methods}
        busyMethod={busyMethod}
        error={error}
        subtitle={returnTo ? `Sign in to continue` : undefined}
        onGoogle={handleGoogle}
        onPasskey={handlePasskey}
        onClose={closeLogin}
      />
    </PeridotContext.Provider>
  );
}
