import { useEffect, useState, type ReactNode } from "react";
import { BrandTop } from "../../shared/components/shell/BrandTop";
import { PageFooter, SOURCE_CODE_URL } from "../../shared/components/shell/PageFooter";
import { AsciiRidges } from "../../shared/components/ui/AsciiRidges";
import { buttonVariants } from "../../shared/components/ui/Button";
import { cn } from "../../shared/styles/cn";
import { Globe, KeyRound, Plus, ReceiptText } from "../../shared/components/icons";

// Public page (`/about`): no session, no wallet shell, no API calls — the same
// bundle serves a signed-in user and a stranger who followed the footer link.
// Layout mirrors Internet Identity's about page (hero, three cards, FAQ) so the
// two read as the same kind of product page; the copy is PeridotID's.

const HERO_WORDS = ["Real ownership", "No seed phrase", "One identity", "PeridotID"];

const CARDS = [
  {
    icon: Globe,
    header: "Easy access",
    subheader: "Sign in your way",
    body: "Google, an email code, a passkey, or a wallet you already have. One PID, and every app that asks for it gets an answer you approved.",
  },
  {
    icon: KeyRound,
    header: "Password-free",
    subheader: "Passkeys, not phrases",
    body: "Your signing key is created and unlocked by your own device — Face ID, fingerprint, or device PIN. Nothing to write down, nothing to leak.",
  },
  {
    icon: ReceiptText,
    header: "Full control",
    subheader: "Apps, money, sessions",
    body: "Approve an app once and choose what it may do. Sessions, permissions and every Rupiah ledger entry stay visible — and revocable — in the wallet.",
  },
];

const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: "What is PeridotID?",
    a: (
      <p>
        An identity wallet for gaming. You choose one permanent PID — something like{" "}
        <span className="font-mono">you@pid</span> — and it comes with one personal wallet on Solana. Signing is
        done by a passkey instead of a password or a seed phrase.
      </p>
    ),
  },
  {
    q: "Is my Face ID or fingerprint stored by PeridotID?",
    a: (
      <p>
        No. Your face or fingerprint only unlocks the passkey on your device. Biometric data never leaves the
        device, and is never shared with PeridotID, or with the apps you use.
      </p>
    ),
  },
  {
    q: "Who holds my keys and my money?",
    a: (
      <p>
        You do. PeridotID is non-custodial: the key that signs for your wallet lives inside a passkey on your
        device, and the service never holds it. Rupiah balances are ledger entries the API issues — each one
        visible, and every movement auditable, in the wallet.
      </p>
    ),
  },
  {
    q: "What can an app do once I approve it?",
    a: (
      <p>
        Only what you approved. Each app gets its own session with its own permissions and expiry — never your
        keys. You can review and revoke any session from the wallet, and verified partners are marked as such
        before you approve them.
      </p>
    ),
  },
  {
    q: "What happens if I lose my phone?",
    a: (
      <p>
        Passkeys sync through your password manager (iCloud Keychain, Google Password Manager, 1Password), so a
        new device can use the same passkey. If a device is gone for good, revoke its session from the wallet.
        There is no seed phrase to lose.
      </p>
    ),
  },
  {
    q: "Is PeridotID open source?",
    a: (
      <p>
        Yes. The wallet, the contracts and the SDKs are public —{" "}
        <a href={SOURCE_CODE_URL} target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4">
          read the code
        </a>{" "}
        or start from the{" "}
        <a href="https://docs.peridot.id" target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4">
          documentation
        </a>
        .
      </p>
    ),
  },
];

/** Cycles the hero word; the fade is the `about-word` keyframe in base.css. */
function useRotatingWord(words: string[], ms = 2600) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % words.length), ms);
    return () => clearInterval(id);
  }, [words.length, ms]);
  return words[i];
}

export function About() {
  const word = useRotatingWord(HERO_WORDS);
  // `isolate`: AsciiRidges paints at z-index -1, so the page itself has to be
  // the stacking context or its own background hides the ridges.
  return (
    <div className="isolate flex min-h-dvh flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center px-4 md:px-6 lg:px-8">
        <a href="/" className="inline-flex outline-0" aria-label="PeridotID home">
          <BrandTop />
        </a>
      </header>

      {/* Hero: the sign-in backdrop, dimmed to a header band and faded out at
          the bottom so the card row starts on flat ground. */}
      <section className="relative flex h-[392px] w-full items-center justify-center overflow-hidden px-6 sm:h-[512px]">
        <div className="absolute inset-0 hidden md:block">
          <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[200px] bg-gradient-to-t from-background to-transparent" />
        <div className="relative flex w-full flex-col items-center justify-center text-center">
          <h1 className="mb-2 font-sans text-4xl leading-[1.1] text-muted-foreground md:text-5xl lg:text-7xl">Experience</h1>
          <span
            key={word}
            className="animate-[about-word_500ms_ease_both] font-sans text-4xl leading-[1.1] font-semibold text-foreground md:text-5xl lg:text-7xl"
          >
            {word}
          </span>
          <p className="mt-6 mb-6 max-w-[600px] text-balance font-sans text-base text-paragraph">
            PeridotID gives you one identity for gaming: a passkey-secured wallet on Solana and Rupiah you can
            actually spend — no passwords, no seed phrase, no account to hand over.
          </p>
          <a href="/" className={cn(buttonVariants({ variant: "primary" }), "w-auto px-8")}>
            Get started
          </a>
        </div>
      </section>

      <div className="w-full min-w-0 overflow-x-auto px-4 pt-4 pb-8 sm:px-8">
        <div className="flex min-w-fit flex-row flex-nowrap justify-center gap-4">
          {CARDS.map(({ icon: Icon, header, subheader, body }) => (
            <div key={header} className="flex w-[300px] shrink-0 flex-col gap-3 rounded-xl border border-border bg-surface p-6">
              <Icon size={22} className="text-accent" aria-hidden />
              <div className="flex flex-col gap-1">
                <span className="font-sans text-xs text-muted-foreground">{header}</span>
                <span className="font-sans text-lg font-semibold text-foreground">{subheader}</span>
              </div>
              <p className="font-sans text-sm leading-relaxed text-paragraph">{body}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-10 px-4 py-16 md:px-16 lg:flex-row lg:py-24">
        <div className="flex flex-1 flex-col gap-3">
          <p className="text-center font-sans text-xs text-muted-foreground md:text-start md:text-sm">
            Understanding PeridotID
          </p>
          <p className="text-center font-sans text-3xl font-semibold text-foreground md:text-start md:text-4xl">
            FAQs
          </p>
          <p className="text-center font-sans text-sm text-paragraph md:text-start md:text-lg">
            Everything you need to know about your PID, your passkey and your Rupiah balance.
          </p>
        </div>
        <div className="mx-5 flex flex-1 flex-col divide-y divide-border">
          {FAQ.map(({ q, a }) => (
            <details key={q} className="group pb-6">
              <summary className="flex cursor-pointer list-none items-center gap-4 py-8 font-sans text-base font-medium text-foreground select-none md:text-lg [&::-webkit-details-marker]:hidden">
                {q}
                <Plus
                  size={20}
                  aria-hidden
                  className="ml-auto shrink-0 text-muted-foreground transition-transform duration-200 [details[open]_&]:rotate-45"
                />
              </summary>
              <div className="-mt-2 flex flex-col gap-3 font-sans text-sm leading-relaxed text-paragraph md:text-base [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4">
                {a}
              </div>
            </details>
          ))}
        </div>
      </div>

      <div className="mx-auto w-full max-w-[1100px] px-4 pb-2 md:px-16">
        <p className="font-sans text-xs text-muted-foreground">PeridotID is a product of PT Antigane Labs Indonesia.</p>
      </div>
      <PageFooter />
    </div>
  );
}
