import { BrowserRouter } from "react-router";
import { WorkspaceProvider, WorkspaceTopbar } from "./shared/components/workspace-provider";
import { AppRoutes } from "./pages/route";

/**
 * Session context + one topbar for the whole dashboard. Routes and layouts are
 * registered in pages/route.tsx; this file only owns the bootstrap.
 */
export default function App() {
  return (
    <BrowserRouter>
      <WorkspaceProvider>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-foreground focus:px-3 focus:py-2 focus:text-sm focus:text-background"
        >
          Skip to content
        </a>
        <WorkspaceTopbar />
        <AppRoutes />
      </WorkspaceProvider>
    </BrowserRouter>
  );
}
