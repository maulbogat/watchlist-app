import { StrictMode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.js";
import "../styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
    },
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) {
  const note = document.createElement("div");
  note.setAttribute("role", "alert");
  note.style.cssText =
    "max-width:36rem;margin:2rem auto;padding:1rem 1.25rem;font-family:system-ui,sans-serif;line-height:1.5;color:#f5f5f5;background:#2a1515;border:1px solid #a44;";
  note.innerHTML = `<strong>React did not mount.</strong> This page has no <code>#root</code>. Run <code>npm run dev:react</code> from the project root and open the URL Vite prints (or use the built <code>dist/index.html</code>).`;
  document.body.prepend(note);
  console.error("movie-trailer-site: missing #root — wrong HTML entry or empty shell.");
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <BrowserRouter>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </BrowserRouter>
    </StrictMode>
  );
}
