import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

export default withMDX({
  reactStrictMode: true,
  output: "standalone",
  async redirects() {
    return [
      // Docs keep the /docs prefix (ANT-100 §2): root promotes into docs.
      { source: "/", destination: "/docs", permanent: true },
      // Workspace console is deleted from docs (ANT-100 §4): temporary
      // redirect to /docs. The dashboard backlog issue owns the final mapping.
      { source: "/workspace/:path*", destination: "/docs", permanent: false },
    ];
  },
});
