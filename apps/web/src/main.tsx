import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./styles.css";
import SharedView from "./components/SharedView";
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 60_000 } },
});
const sharedId = window.location.pathname.match(
  /^\/shared\/([A-Za-z0-9_-]+)$/,
)?.[1];
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {sharedId ? <SharedView snapshotId={sharedId} /> : <App />}
    </QueryClientProvider>
  </React.StrictMode>,
);
