import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import { PROVENANCE_STATUS, type ImageProvenance } from "../../../src/shared/image-provenance.js";
import { TEXT } from "../constants.js";
import { ImageProvenanceLine } from "./image-provenance.js";
import { ImageTrustCard } from "./image-trust.js";
import type { ImageTrustView } from "../queries.js";

const text = TEXT.provenance;
const PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----\nMFkwEwYH\n-----END PUBLIC KEY-----";
const view: ImageTrustView = {
  publishers: [{ name: "example", publicKey: PUBLIC_KEY, keyType: "ec", createdBy: "admin", createdAt: 1 }],
  rules: [{ id: "r1", registry: "ghcr.io", repository: "example/app", publishers: ["example"] }],
  revision: 3,
};

let client: QueryClient;
let current: ImageTrustView;
let sent: { url: string; method: string; body: Record<string, unknown> | null }[];

beforeEach(() => {
  current = view;
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      const method = options?.method ?? "GET";
      if (method === "GET") {
        return new Response(JSON.stringify(current), { headers: { "content-type": "application/json" } });
      }
      sent.push({ url, method, body: options?.body === undefined ? null : JSON.parse(String(options.body)) });
      return new Response(null, { status: 204 });
    }),
  );
});

afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ImageTrustCard />
    </QueryClientProvider>,
  );
}

it("shows who is trusted, what kind of key each has, and where a signed image is required", async () => {
  show();

  expect(await screen.findByText(text.keyType("ec"))).toBeTruthy();
  expect(screen.getAllByText("example").length).toBeGreaterThan(0);
  expect(screen.getByText("ghcr.io/example/app")).toBeTruthy();
});

it("trusts a publisher by its public key, which it sends as it was pasted", async () => {
  show();
  fireEvent.change(await screen.findByLabelText(text.publisherName), { target: { value: "someone" } });
  fireEvent.change(screen.getByLabelText(text.publisherKey), { target: { value: PUBLIC_KEY } });
  fireEvent.submit(screen.getByLabelText(text.addPublisher));

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toEqual({
    url: API_ROUTES.imageTrust,
    method: "POST",
    body: { name: "someone", publicKey: PUBLIC_KEY },
  });
});

it("requires a signed image for a scope, from the publishers that were ticked", async () => {
  show();
  fireEvent.change(await screen.findByLabelText(text.registry), { target: { value: "ghcr.io" } });
  fireEvent.change(screen.getByLabelText(text.repository), { target: { value: "owner/other" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "example" }));
  fireEvent.submit(screen.getByLabelText(text.addRule));

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toEqual({
    url: API_ROUTES.imageTrustRules,
    method: "POST",
    body: { registry: "ghcr.io", repository: "owner/other", publishers: ["example"] },
  });
});

it("asks before it stops trusting a publisher or drops a rule", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  show();

  fireEvent.click(await screen.findByRole("button", { name: text.removeRuleFor("ghcr.io/example/app") }));
  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toMatchObject({ url: apiPath(API_ROUTES.imageTrustRule, { ruleId: "r1" }), method: "DELETE" });

  fireEvent.click(screen.getByRole("button", { name: text.removePublisherFor("example") }));
  await waitFor(() => expect(sent).toHaveLength(2));
  expect(sent[1]).toMatchObject({
    url: apiPath(API_ROUTES.imageTrustPublisher, { name: "example" }),
    method: "DELETE",
  });
});

it("says plainly when nothing is trusted, and offers no rule until something is", async () => {
  current = { publishers: [], rules: [], revision: 0 };
  show();

  expect(await screen.findByText(text.none)).toBeTruthy();
  expect(screen.getByText(text.noRules)).toBeTruthy();
  expect(screen.queryByLabelText(text.addRule)).toBeNull();
});

const provenance = (change: Partial<ImageProvenance>): ImageProvenance => ({
  status: PROVENANCE_STATUS.verified,
  digest: `sha256:${"a".repeat(64)}`,
  publisher: "example",
  checkedAt: 1,
  problem: null,
  ...change,
});

it("says beside an update who signed the image, or why that is not proof", () => {
  const { rerender } = render(<ImageProvenanceLine provenance={provenance({})} />);
  expect(screen.getByText(text.verified("example"))).toBeTruthy();

  rerender(
    <ImageProvenanceLine
      provenance={provenance({
        status: PROVENANCE_STATUS.unsigned,
        publisher: null,
        problem: "the registry keeps no signature for this image",
      })}
    />,
  );
  expect(screen.getByText(new RegExp(text.unsigned))).toBeTruthy();
  expect(screen.getByText(/keeps no signature/)).toBeTruthy();
});

it("says nothing at all where nothing asked for proof", () => {
  const { container } = render(<ImageProvenanceLine provenance={null} />);
  expect(container.textContent).toBe("");
});
