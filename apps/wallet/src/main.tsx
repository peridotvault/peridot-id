import "./shared/app/shims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { pages } from "./pages/route";
import { hydrateCache } from "./shared/data/apiCache";
import { hydrateCurrency } from "./shared/data/currency";
import { hydratePrefs } from "./shared/data/db";
import { hydrateSelection } from "./shared/data/selectedChains";

// Public page: `/about` is readable by anyone, so it skips the wallet shell and
// the session check (and therefore the startup gate's splash wait).
const about = window.location.pathname.replace(/\/+$/, "") === "/about";
if (about) document.getElementById("splash")?.remove();

const About = pages.about;

// Warm the IndexedDB-backed state before the first paint: `peekCached` is
// synchronous, and the stored currency/chains must not flash the defaults.
// These are cheap reads and the splash is already on screen.
async function start(): Promise<void> {
  if (!about) {
    await Promise.all([hydrateCache(), hydratePrefs(), hydrateCurrency()]);
    hydrateSelection();
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>{about ? <About /> : <App />}</StrictMode>,
  );
}

void start();
