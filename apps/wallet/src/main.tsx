import "./shared/app/shims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { pages } from "./pages/route";

// Public page: `/about` is readable by anyone, so it skips the wallet shell and
// the session check (and therefore the startup gate's splash wait).
const about = window.location.pathname.replace(/\/+$/, "") === "/about";
if (about) document.getElementById("splash")?.remove();

const About = pages.about;

createRoot(document.getElementById("root")!).render(
  <StrictMode>{about ? <About /> : <App />}</StrictMode>,
);
