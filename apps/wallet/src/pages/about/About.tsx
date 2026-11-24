import { BrandTop } from "../../shared/components/shell/BrandTop";
import { PageFooter, SOURCE_CODE_URL } from "../../shared/components/shell/PageFooter";

// Public page (`/about`): no session, no wallet shell, no API calls — the same
// bundle serves a signed-in user and a stranger who followed the footer link.
export function About() {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="px-6 pb-3 pt-5">
        <a href="/" className="inline-flex outline-0" aria-label="PeridotID home">
          <BrandTop />
        </a>
      </header>
      <main className="mx-auto flex w-full max-w-[620px] flex-1 flex-col gap-4 px-6 py-10">
        <h1 className="font-sans text-2xl font-semibold text-foreground">About PeridotID</h1>
        <p className="font-sans text-sm leading-relaxed text-paragraph">
          PeridotID is an identity wallet for gaming. One PID (<span className="font-mono">you@pid</span>), one
          wallet, one passkey — no seed phrase to write down, and no password to reuse across games.
        </p>
        <p className="font-sans text-sm leading-relaxed text-paragraph">
          It is non-custodial. The key that signs for your wallet is held by a passkey on your own device; the
          PeridotID service verifies your identity and never holds your keys or your money.
        </p>
        <p className="font-sans text-sm leading-relaxed text-paragraph">
          Games and apps ask for your PID, and you approve what each one may do — its own scoped session on
          Solana, never your keys. Payments and balances in Rupiah are recorded on a ledger the API issues and
          that you can audit entry by entry in the wallet.
        </p>
        <nav className="mt-2 flex flex-wrap gap-x-4 gap-y-2 font-sans text-sm">
          <a href="https://docs.peridot.id" target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4 hover:text-accent">
            Documentation
          </a>
          <a href={SOURCE_CODE_URL} target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4 hover:text-accent">
            Source code
          </a>
          <a href="/" className="text-foreground underline underline-offset-4 hover:text-accent">
            Open the wallet
          </a>
        </nav>
      </main>
      <PageFooter className="mx-auto w-full max-w-[620px]" />
    </div>
  );
}
