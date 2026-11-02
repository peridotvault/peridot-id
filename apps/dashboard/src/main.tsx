import "./shims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "../App";

// Dark only (brand.md): index.html pins `class="dark"` on <html>.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
