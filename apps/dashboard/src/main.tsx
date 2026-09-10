// apps/dashboard/src/main.tsx — the browser entry Vite bundles.
//
// The OLD console is untouched by this task: `renderShellHtml` (src/lib/serve.ts) still serves the
// operator's string shell at `/`, which is the fallback the strangler ruling requires stay alive
// until the operator judges parity. This tree is served under /console/ by the W1-T3175 mount.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { clientFor, readConfig } from "./config";
import "./theme.css";

const config = readConfig(window.location.search);
const client = config === null ? null : clientFor(config);
const root = document.getElementById("root");
if (root === null) throw new Error("apps/dashboard: no #root element — index.html and this entry disagree");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <App client={client} />
    </QueryClientProvider>
  </StrictMode>,
);
