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
          <Route path="*" element={<NotFound />} />
        </Routes>
      </WorkspaceProvider>
    </BrowserRouter>
  );
}

function NotFound() {
  return (
    <main className="mx-auto w-full max-w-7xl px-5 py-16 sm:px-8">
      <p className="mt-8 text-sm text-muted-foreground">
        Not found. <a href="/" className="underline">Back to dashboard</a>
      </p>
    </main>
  );
}
