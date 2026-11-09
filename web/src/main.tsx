import "./schema-runtime.js";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { HTTP_STATUS } from "../../src/shared/constants.js";
import { ApiError, queryRetryDelay, shouldRetryQuery } from "./api-client.js";
import { SESSION_QUERY_KEY } from "./constants.js";
import { router } from "./router.js";
import { reloadIntoNewBuild } from "./stale-build.js";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./styles/app.css";

// A 401 anywhere means the session ended (idle, deactivated, restored): re-check it, and the
// router sends the browser back to sign-in.
const recheckSessionOn401 = (error: unknown) => {
  if (error instanceof ApiError && error.status === HTTP_STATUS.unauthorized) {
    void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  }
};

reloadIntoNewBuild(
  window,
  () => window.sessionStorage,
  () => window.location.reload(),
);

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: recheckSessionOn401 }),
  mutationCache: new MutationCache({ onError: recheckSessionOn401 }),
  defaultOptions: { queries: { retry: shouldRetryQuery, retryDelay: queryRetryDelay } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
