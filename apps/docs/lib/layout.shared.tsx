import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

const CUT =
  "[clip-path:polygon(6px_0,100%_0,100%_calc(100%-6px),calc(100%-6px)_100%,0_100%,0_6px)]";

function NavTitle() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        className={`h-7 w-7 bg-foreground ${CUT}`}
        aria-hidden="true"
      />
      <span className="text-[17px] font-semibold tracking-tight">Peridot ID</span>
    </span>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <NavTitle />,
      transparentMode: 'top',
    },
    githubUrl: 'https://github.com/peridotvault/peridot-id',
    links: [
      {
        type: 'menu',
        text: 'Platform',
        items: [
          { url: '/docs/getting-started', text: 'Getting Started', description: 'Set up your first app' },
          { url: '/docs/sdk', text: 'SDK', description: 'Drop-in identity SDKs' },
          { url: '/docs/authentication', text: 'Authentication', description: 'Google sign-in & sessions' },
          { url: '/docs/self-hosting', text: 'Self-hosting', description: 'Run it on your infra' },
        ],
      },
      { url: '/docs', text: 'Docs', active: 'nested-url' },
      { url: '/docs/api', text: 'API Reference', active: 'nested-url' },
    ],
  };
}
