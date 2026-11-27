import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { PageErrorBoundary } from "../shared/components/error-boundary";
import { AdminLayout } from "../feat/admin/admin-layout";
import { WorkspaceLayout } from "../feat/workspace/workspace-layout";
import HomePage from "./home";
import AppDetailPage from "./app-detail-page";
import AdminChainFamiliesPage from "./admin-chain-families";
import AdminChainDetailPage from "./admin-chain-detail";
import AdminChainGeneralPage from "./admin-chain-general";
import AdminChainContractsPage from "./admin-chain-contracts";
import AdminChainTokensPage from "./admin-chain-tokens";
import AdminProvidersPage from "./admin-providers";
import AdminProviderCreatePage from "./admin-provider-create";
import AdminProviderDetailPage from "./admin-provider-detail";
import AdminLoginActivityPage from "./admin-login-activity";
import AdminUsersPage from "./admin-users";
import AdminLedgerPage from "./admin-ledger";
import AdminLedgerDangerPage from "./admin-ledger-danger";
import ChainsPage from "./chains";
import ChainsCreatePage from "./chains-create";
import FeesPage from "./fees";
import PartnersPage from "./partners";
import DemoPage from "./demo";
import LevelingOverviewPage from "./leveling-overview";
import LevelingLevelsPage from "./leveling-levels";
import LevelingTasksPage from "./leveling-tasks";
import LevelingHistoryPage from "./leveling-history";
import LevelingSettingsPage from "./leveling-settings";
import LevelingAppsPage from "./leveling-apps";
import SystemSettingsPage from "./system-settings";

/**
 * Route table for the dashboard. Pages register here (their own directory);
 * layouts come from feat/. The shell (providers + topbar) lives in App.tsx.
 */
export function AppRoutes() {
  return (
    <RouteBoundary>
      <Routes>
        <Route element={<WorkspaceLayout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/apps/:env/:id" element={<AppDetailPage />} />
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
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="ledger" element={<AdminLedgerPage />} />
          <Route path="ledger/danger" element={<AdminLedgerDangerPage />} />
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
  );
}

// Whole-tree boundary: a crash in a layout (not just a page) must show the
// error instead of a blank screen that "needs a refresh". Keyed by location so
// the next navigation clears it.
function RouteBoundary({ children }: { children: ReactNode }) {
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
