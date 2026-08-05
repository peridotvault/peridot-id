import { CutButton } from "@/components/landing/cut-button";
import { Logo } from "@/components/landing/logo";
import type { CSSProperties, ReactNode } from "react";

type FooterLink = { label: string; href: string };

const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Platform", href: "/" },
      { label: "Pricing", href: "/#pricing" },
      { label: "Getting Started", href: "/docs/getting-started" },
      { label: "SDK", href: "/docs/sdk" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Documentation", href: "/docs" },
      { label: "API Reference", href: "/docs/api/auth" },
      { label: "Authentication", href: "/docs/authentication" },
      { label: "Self-hosting", href: "/docs/self-hosting" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy Policy", href: "#privacy" },
      { label: "Terms & Conditions", href: "#terms" },
    ],
  },
];

function BrandIcon({ path }: { path: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="h-4 w-4">
      <path d={path} />
    </svg>
  );
}

const SOCIALS: { label: string; href: string; icon: ReactNode }[] = [
  {
    label: "GitHub",
    href: "https://github.com/peridotvault/peridot-id",
    icon: (
      <BrandIcon path="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.78 0c2.21-1.49 3.18-1.18 3.18-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
    ),
  },
  {
    label: "LinkedIn",
    href: "#linkedin",
    icon: (
      <BrandIcon path="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.13 1.44-2.13 2.94v5.67H9.36V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.55C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.72C24 .77 23.2 0 22.22 0z" />
    ),
  },
  {
    label: "X",
    href: "#x",
    icon: (
      <BrandIcon path="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    ),
  },
  {
    label: "YouTube",
    href: "#youtube",
    icon: (
      <BrandIcon path="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 0 0 .5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 0 0 2.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 0 0 2.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.55 15.57V8.43L15.82 12l-6.27 3.57z" />
    ),
  },
];

const PANEL_CLIP =
  "polygon(28px 0, 100% 0, 100% calc(100% - 28px), calc(100% - 28px) 100%, 0 100%, 0 28px)";

function Plus({ className }: { className: string }): ReactNode {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={`pointer-events-none absolute z-10 h-3.5 w-3.5 text-[#2f80ff] ${className}`}
    >
      <path
        d="M12 4v16M4 12h16"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FooterColumn({
  index,
  title,
  links,
  children,
}: {
  index: number;
  title: string;
  links: FooterLink[];
  children?: ReactNode;
}): ReactNode {
  const divided = index > 0;
  return (
    <div
      className={`relative md:px-8 ${divided ? "md:border-l md:border-border" : "md:pl-0"} ${
        index === 3 ? "md:pr-0" : ""
      }`}
    >
      {divided && (
        <>
          <Plus className="left-0 top-0 hidden -translate-x-1/2 -translate-y-1/2 md:block" />
          <Plus className="bottom-0 left-0 hidden -translate-x-1/2 translate-y-1/2 md:block" />
        </>
      )}

      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      <ul className="mt-4 space-y-3">
        {links.map((link) => (
          <li key={link.href}>
            <a
              href={link.href}
              className="focus-ring text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
      {children}
    </div>
  );
}

export function Footer(): ReactNode {
  const clip = { clipPath: PANEL_CLIP } as CSSProperties;

  return (
    <footer className="mx-auto max-w-[1440px] px-5 pb-10 sm:px-8 lg:px-10">
      <div className="bg-border p-px" style={clip}>
        <div
          className="bg-background p-8 sm:p-10 lg:p-14"
          style={clip}
        >
          <Logo />

          <div className="mt-12 grid grid-cols-2 gap-x-8 gap-y-10 md:mt-14 md:grid-cols-4 md:gap-x-0">
            {COLUMNS.map((col, i) => (
              <FooterColumn
                key={col.title}
                index={i}
                title={col.title}
                links={col.links}
              />
            ))}

            <FooterColumn
              index={3}
              title="Connect"
              links={[{ label: "GitHub", href: "https://github.com/peridotvault/peridot-id" }]}
            >
              <div className="mt-6 flex flex-col items-start gap-2.5">
                <CutButton variant="solid" href="/docs/getting-started">
                  Get started
                </CutButton>
                <CutButton variant="outline" href="/docs">
                  Read the docs
                </CutButton>
              </div>
            </FooterColumn>
          </div>

          <div className="mt-12 flex flex-col-reverse items-start justify-between gap-6 pt-6 sm:flex-row sm:items-center md:mt-14">
            <p className="text-xs text-muted-foreground">
              © {new Date().getFullYear()} Peridot ID. All rights reserved.
            </p>

            <div className="flex items-center gap-4">
              {SOCIALS.map((social, i) => (
                <div key={social.href} className="flex items-center gap-4">
                  {i > 0 && (
                    <span className="h-3.5 w-px bg-border" aria-hidden="true" />
                  )}
                  <a
                    href={social.href}
                    aria-label={social.label}
                    className="focus-ring text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {social.icon}
                  </a>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
