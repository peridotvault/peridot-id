import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { WorkspaceProvider, WorkspaceTopbar } from "./src/workspace/workspace-provider";
import { WorkspaceLayout } from "./src/workspace/workspace-layout";
import { AdminLayout } from "./src/feat/admin/admin-layout";
import { PageErrorBoundary } from "./src/workspace/error-boundary";
import HomePage from "./src/routes/home";
import AppDetailPage from "./src/routes/app-detail-page";
import AdminChainFamiliesPage from "./src/routes/admin-chain-families";
import AdminChainDetailPage from "./src/routes/admin-chain-detail";
import AdminChainGeneralPage from "./src/routes/admin-chain-general";
import AdminChainContractsPage from "./src/routes/admin-chain-contracts";
import AdminChainTokensPage from "./src/routes/admin-chain-tokens";
import AdminProvidersPage from "./src/routes/admin-providers";
import AdminProviderCreatePage from "./src/routes/admin-provider-create";
import AdminProviderDetailPage from "./src/routes/admin-provider-detail";
import AdminLoginActivityPage from "./src/routes/admin-login-activity";
import ChainsPage from "./src/routes/chains";
import ChainsCreatePage from "./src/routes/chains-create";
import FeesPage from "./src/routes/fees";
import PartnersPage from "./src/routes/partners";
import DemoPage from "./src/routes/demo";
import LevelingOverviewPage from "./src/routes/leveling-overview";
import LevelingLevelsPage from "./src/routes/leveling-levels";
import LevelingTasksPage from "./src/routes/leveling-tasks";
import LevelingHistoryPage from "./src/routes/leveling-history";
import LevelingSettingsPage from "./src/routes/leveling-settings";
import LevelingAppsPage from "./src/routes/leveling-apps";
import SystemSettingsPage from "./src/routes/system-settings";

/**
 * Session context + one topbar for the whole dashboard. Workspace routes
 * (/, /apps/:id, chains, fees, …) sit under WorkspaceLayout (session gate);
 * every admin console lives under /admin/* behind AdminLayout (role gate + its
 * own rail). /demo is the public third-party sample page and stays outside both.
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
        {/* Whole-tree boundary: a crash in a layout (not just a page) must show
            the error instead of a blank screen that "needs a refresh". Keyed by
            location so the next navigation clears it. */}
        <RouteBoundary>
        <Routes>
          <Route element={<WorkspaceLayout />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/apps/:id" element={<AppDetailPage />} />
          </Route>
          <Route path="/demo" element={<DemoPage />} />

          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<Navigate to="/admin/providers" replace />} />
            <Route path="providers" element={<AdminProvidersPage />} />
            <Route path="providers/new" element={<AdminProviderCreatePage />} />
            <Route path="providers/:code" element={<AdminProviderDetailPage />} />
            <Route path="chain-families" element={<AdminChainFamiliesPage />} />
            <Route path="chains" element={<ChainsPage />} />
            <Route path="chains/create" element={<ChainsCreatePage />} />
            <Route path="chains/:id" element={<AdminChainDetailPage />}>
              <Route index element={<Navigate to="general" replace />} />
              <Route path="general" element={<AdminChainGeneralPage />} />
              <Route path="contracts" element={<AdminChainContractsPage />} />
              <Route path="tokens" element={<AdminChainTokensPage />} />
            </Route>
            <Route path="fees" element={<FeesPage />} />
            <Route path="partners" element={<PartnersPage />} />
            <Route path="login-activity" element={<AdminLoginActivityPage />} />
            <Route path="leveling" element={<LevelingOverviewPage />} />
            <Route path="leveling/levels" element={<LevelingLevelsPage />} />
            <Route path="leveling/tasks" element={<LevelingTasksPage />} />
            <Route path="leveling/history" element={<LevelingHistoryPage />} />
            <Route path="leveling/settings" element={<LevelingSettingsPage />} />
            <Route path="leveling/apps" element={<LevelingAppsPage />} />
            <Route path="settings" element={<SystemSettingsPage />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Routes>
        </RouteBoundary>
      </WorkspaceProvider>
    </BrowserRouter>
  );
}

function RouteBoundary({ children }: { children: React.ReactNode }) {
  const { pathname, search } = useLocation();
  return <PageErrorBoundary key={`${pathname}${search}`}>{children}</PageErrorBoundary>;
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
