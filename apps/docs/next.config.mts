import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// Dashboard base for the final /workspace/* mapping (ANT-108 §4 / ANT-110):
// PID_DASHBOARD_URL (canonical) -> NEXT_PUBLIC_PID_DASHBOARD_URL (legacy,
// still used by lib/layout.shared.tsx Login button — keep working) ->
// dev default http://localhost:3303. Never hardcode a prod host: prod ships
// as env-driven config until dashboard hosting lands (Trevor/CTO ticket).
// NOTE (build-time caveat): next.config.mts is evaluated at BUILD time, so the
// dashboard host is baked into the build. Preview/CI builds must inject the
// env var at build time; a runtime-only env change will NOT move the redirect.
const dashboardBase =
  process.env.PID_DASHBOARD_URL ??
  process.env.NEXT_PUBLIC_PID_DASHBOARD_URL ??
  "http://localhost:3303";

export default withMDX({
  reactStrictMode: true,
  output: "standalone",
  async redirects() {
    return [
      // Docs keep the /docs prefix (ANT-100 §2): root promotes into docs.
      { source: "/", destination: "/docs", permanent: true },
      // Final workspace mapping (ANT-108 §3 / ANT-110): /workspace/* restores
      // the ANT-85 passthrough at the new docs location — sub-paths land on
      // the equivalent dashboard route. 307 Temporary (permanent:false):
      // the prod dashboard host is still unknown, and a 308 would be cached
      // persistently by browsers past a host change. Query strings are
      // preserved automatically by Next.js redirects(). Docs side stays
      // stateless (no cookie/session logic). The bare /workspace path needs
      // its own entry — :path* does not match it on all Next versions.
      { source: "/workspace", destination: `${dashboardBase}/`, permanent: false },
      { source: "/workspace/:path*", destination: `${dashboardBase}/:path*`, permanent: false },
    ];
  },
});
