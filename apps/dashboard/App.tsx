import { BrowserRouter, Route, Routes } from "react-router";
import { WorkspaceProvider, WorkspaceTopbar } from "./src/workspace/workspace-provider";
import HomePage from "./src/routes/home";
import AppDetailPage from "./src/routes/app-detail-page";
import ChainsPage from "./src/routes/chains";
import ChainsCreatePage from "./src/routes/chains-create";
import ChainsEditPage from "./src/routes/chains-edit";
import ContractsPage from "./src/routes/contracts";
import FeesPage from "./src/routes/fees";
import PartnersPage from "./src/routes/partners";
import DemoPage from "./src/routes/demo";
import LevelingOverviewPage from "./src/routes/leveling-overview";
import LevelingLevelsPage from "./src/routes/leveling-levels";
import LevelingTasksPage from "./src/routes/leveling-tasks";
import LevelingHistoryPage from "./src/routes/leveling-history";
import LevelingSettingsPage from "./src/routes/leveling-settings";
import LevelingAppsPage from "./src/routes/leveling-apps";

/**
 * Dashboard shell: session context + topbar around every route.
 * Route table mirrors apps/docs/app/workspace (§1.1) with /workspace stripped:
 * / → Apps+gate, /apps/:id, /chains, /chains/create, /chains/edit,
 * /contracts, /fees, /partners, /demo.
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
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/apps/:id" element={<AppDetailPage />} />
          <Route path="/chains" element={<ChainsPage />} />
          <Route path="/chains/create" element={<ChainsCreatePage />} />
          <Route path="/chains/edit" element={<ChainsEditPage />} />
          <Route path="/contracts" element={<ContractsPage />} />
          <Route path="/fees" element={<FeesPage />} />
          <Route path="/partners" element={<PartnersPage />} />
          <Route path="/demo" element={<DemoPage />} />
          <Route path="/leveling" element={<LevelingOverviewPage />} />
          <Route path="/leveling/levels" element={<LevelingLevelsPage />} />
          <Route path="/leveling/tasks" element={<LevelingTasksPage />} />
          <Route path="/leveling/history" element={<LevelingHistoryPage />} />
          <Route path="/leveling/settings" element={<LevelingSettingsPage />} />
          <Route path="/leveling/apps" element={<LevelingAppsPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </WorkspaceProvider>
    </BrowserRouter>
  );
}

function NotFound() {
  return (
    <main id="main-content" className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
      <p className="mt-8 text-sm text-muted-foreground">
        Not found. <a href="/" className="underline">Back to dashboard</a>
      </p>
    </main>
  );
}
