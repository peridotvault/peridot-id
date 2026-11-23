import { Section, SectionHead } from "../../shared/components/ui/Section";
import { UIButton } from "../../shared/components/ui/UIButton";

/**
 * Embedded wallet entry: shown inside the iframe before the parent hands over a
 * bearer. Sign-in itself opens the PeridotID popup on the parent's behalf (the
 * iframe can't hold the session cookie cross-site).
 */
export function EmbedConnect({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="flex flex-1 flex-col">
      <Section className="border-t-0">
        <SectionHead className="flex flex-col gap-4 pb-8">
          <h1 className="text-xl font-semibold text-foreground">PeridotID</h1>
          <p className="text-sm text-muted-foreground">Connect your PeridotID wallet to continue in this app.</p>
          <UIButton title="Sign in with PeridotID" onPress={onConnect} variant="primary" />
        </SectionHead>
      </Section>
    </div>
  );
}
