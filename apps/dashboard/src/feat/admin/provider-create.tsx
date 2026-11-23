import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../../shared/api";
import { Card, ERROR, FIELD, SECTION_LABEL, MiniButton } from "../../shared/ui/kit";
import { PageHeader } from "../../shared/ui/page-header";
import type { ProviderMeta } from "../../shared/app-types";

const PROTOCOLS: ProviderMeta["protocol"][] = ["oauth", "email_otp", "passkey", "wallet_signature"];

/** Add a catalogue entry: starts disabled until adapter + configuration exist. */
export function ProviderCreate({ client }: { client: PeridotClient }) {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<"web2" | "web3">("web2");
  const [protocol, setProtocol] = useState<ProviderMeta["protocol"]>("oauth");
  const [imageUrl, setImageUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await client.post("/v1/admin/providers", {
          code: code.trim(),
          name: name.trim(),
          category,
          protocol,
          ...(imageUrl.trim() ? { imageUrl: imageUrl.trim() } : {}),
        }),
        "Creating provider",
      );
      navigate(`/admin/providers/${code.trim()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create provider");
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Provider catalogue"
        title="Add provider"
        description="New entries start disabled — they can only be switched on once an adapter exists and the configuration is complete."
      />
      <div className="mt-6 flex flex-col gap-6">
        <Card>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="text-xs">
              Code
              <input className={`${FIELD} font-mono`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="discord" />
            </label>
            <label className="text-xs">
              Display name
              <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder="Discord" />
            </label>
            <label className="text-xs">
              Category
              <select className={FIELD} value={category} onChange={(e) => setCategory(e.target.value as "web2" | "web3")}>
                <option value="web2">Web2</option>
                <option value="web3">Web3</option>
              </select>
            </label>
            <label className="text-xs">
              Protocol
              <select className={FIELD} value={protocol} onChange={(e) => setProtocol(e.target.value as ProviderMeta["protocol"])}>
                {PROTOCOLS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
            <label className="text-xs sm:col-span-2">
              Icon URL (https or same-origin path)
              <input className={FIELD} value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://cdn.example.com/discord.png" />
            </label>
          </div>
          {error && <p role="alert" className={`mt-3 text-sm ${ERROR}`}>{error}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <MiniButton variant="solid" onClick={() => void submit()} disabled={busy || !code.trim() || !name.trim()}>
              {busy ? "Creating…" : "Create provider"}
            </MiniButton>
            <Link to="/admin/providers" className={`text-sm text-muted-foreground transition-colors hover:text-foreground`}>
              Back to providers
            </Link>
          </div>
        </Card>
      </div>
    </>
  );
}
