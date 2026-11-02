import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DiagnosticPreview } from "../../../src/shared/diagnostics.js";
import { DiagnosticsPreview } from "./diagnostics-preview.js";
const prepared: DiagnosticPreview = {
  id: "preview",
  incidentId: "incident",
  expiresAt: Date.now() + 300_000,
  byteLength: 600,
  bundle: {
    format: "autoheal-diagnostics",
    version: 1,
    generatedAt: Date.now(),
    evidence: {
      incident: { detectedAt: null, updatedAt: null, action: "restart", status: "resolved", trigger: "die" },
    },
    manifest: {
      sections: ["facts", "usage"],
      sha256: "a".repeat(64),
      checksumEncoding: "UTF-8 JSON.stringify(evidence)",
      redaction: ["Raw text excluded"],
      truncatedTrace: false,
      truncatedUsage: false,
    },
  },
};
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("requires review, sends explicit choices and downloads once through authenticated POST", async () => {
  const fetch = vi.fn(
    async (path: string, _options: RequestInit) =>
      new Response(JSON.stringify(path.endsWith("/preview") ? prepared : prepared.bundle), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const createObjectURL = vi.fn(() => "blob:diagnostics");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DiagnosticsPreview incidentId="incident" />
    </QueryClientProvider>,
  );
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Download diagnostics"));
  expect(screen.queryByRole("button", { name: "Download reviewed bundle" })).toBeNull();
  fireEvent.click(screen.getByLabelText("Trace event types and timestamps"));
  fireEvent.click(screen.getByRole("button", { name: "Preview diagnostics" }));
  expect(await screen.findByRole("region", { name: "Diagnostic bundle preview" })).toBeTruthy();
  expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({ sections: ["facts", "usage"] });
  fireEvent.click(screen.getByRole("button", { name: "Download reviewed bundle" }));
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Diagnostics downloaded. Create a new preview to download again.",
  );
  expect(fetch.mock.calls[1]![1].method).toBe("POST");
  expect(click).toHaveBeenCalledOnce();
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:diagnostics");
  expect(screen.getByRole("button", { name: "Download reviewed bundle" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByLabelText("Captured numeric usage"));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Diagnostic bundle preview" })).toBeNull());
});
