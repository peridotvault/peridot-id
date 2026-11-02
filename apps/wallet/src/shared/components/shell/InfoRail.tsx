import { useNetworkMode } from "../../hooks/useNetworkMode";
import { useHeaderProfile } from "../../hooks/useHeaderProfile";
import { ProfileButton } from "./ProfileButton";

// Right column (three-column desktop): the profile affordance on top and a
// quiet footer underneath — company line, two links, network mode. No cards,
// no chrome; it is scaffolding, not content.
//
// shortcut: docs/terms URLs are the public marketing routes; repoint them when
// the legal pages ship.
const LINKS = [
  { label: "Docs", href: "https://docs.peridot.id" },
  { label: "Terms", href: "https://peridot.id/terms" },
];

export function InfoRail({ onProfile, refreshKey = "" }: { onProfile: () => void; refreshKey?: string }) {
  const { displayName, avatarUrl, level } = useHeaderProfile(refreshKey);
  const net = useNetworkMode();

  return (
    <aside aria-label="About PeridotID" style={{ width: 300 }} className="flex shrink-0 flex-col gap-8 py-5">
      <div style={{ flexDirection: "row" }} className="flex justify-end">
        <ProfileButton displayName={displayName} avatarUrl={avatarUrl} level={level} onProfile={onProfile} />
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-sans text-sm font-medium text-foreground">Gaming identity wallet</span>
        <span className="font-sans text-xs text-muted-foreground">Part of PT Antigane Labs Indonesia</span>
        {/* ANT-15 req 4: the network mode must stay visible on every shell. */}
        {net.mode === "testnet" ? (
          <span className="mt-1 self-start bg-secondary px-2 py-0.5 font-sans text-xs font-bold tracking-[1px] text-foreground">
            TESTNET
          </span>
        ) : (
          <span className="mt-1 font-mono text-xs text-muted-foreground">mainnet</span>
        )}
        <nav aria-label="Legal" className="mt-2 flex flex-wrap gap-4">
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noreferrer noopener"
              className="font-sans text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </aside>
  );
}
