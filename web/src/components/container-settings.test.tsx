import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobView, ResourceAdviceView } from "../../../src/shared/api.js";
import { BYTES_PER_MEBIBYTE } from "../../../src/shared/constants.js";
import type { ContainerSettings, SettingsAnswer } from "../../../src/shared/protocol.js";
import { JOB_REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { ContainerSettingsEditor } from "./container-settings.js";

const SETTINGS_PATH = "/api/inventory/hosts/h1/containers/paperless/settings";
const JOB_PATH = "/api/jobs/j1";
const ADVICE_PATH = "/api/inventory/hosts/h1/containers/paperless/resource-advice";
const NOT_FOUND = 404;
// The job is answered at its second look, a refresh after the first.
const FOLLOWED_LONG_ENOUGH = 3 * JOB_REFRESH_MILLISECONDS;

const settings: ContainerSettings = {
  environment: [{ name: "PAPERLESS_TIME_ZONE", value: "Europe/Lisbon" }],
  labels: [{ name: "com.docker.compose.project", value: "paperless" }],
  ports: [{ target: 8000, protocol: "tcp", published: 8010, address: "" }],
  mounts: [{ kind: "bind", source: "/srv/paperless/data", target: "/usr/src/paperless/data", readOnly: false }],
  restart: { policy: "unless-stopped", retries: 0 },
};

const job = (status: JobView["status"], outcome: string | null) =>
  ({
    id: "j1",
    action: "edit",
    status,
    outcome,
    output: null,
    requestedBy: "admin",
    createdAt: 1,
    completedAt: null,
  }) as JobView;

// The settings as the runner read them, the edit job it was given, and that job's state as it goes; and, when given,
// what its memory readings suggest.
function serve(answer: SettingsAnswer, advice?: ResourceAdviceView) {
  const sent: unknown[] = [];
  let polls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (url === SETTINGS_PATH && init?.method === "PUT") {
        sent.push(JSON.parse(String(init.body)));
        return json(job("pending", null));
      }
      if (url === SETTINGS_PATH) {
        return json(answer);
      }
      if (url === ADVICE_PATH && advice !== undefined) {
        return json(advice);
      }
      if (url === JOB_PATH) {
        polls += 1;
        return json(
          polls > 1
            ? job("succeeded", "Changed the settings of paperless, and it is running.")
            : job("delivered", null),
        );
      }
      return new Response(null, { status: NOT_FOUND });
    }),
  );
  return sent;
}

function show() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ContainerSettingsEditor hostId="h1" containerName="paperless" onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

describe("a container's settings, in the dashboard", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows them as the runner read them, applies what changed after asking, and follows the job to its end", async () => {
    const sent = serve({ error: null, settings });
    show();

    const value = await screen.findByLabelText("Environment Value 1");
    expect((value as HTMLInputElement).value).toBe("Europe/Lisbon");
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(value, { target: { value: "UTC" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
    fireEvent.change(screen.getByLabelText("Environment Name 2"), { target: { value: "PAPERLESS_OCR_LANGUAGE" } });
    fireEvent.change(screen.getByLabelText("Environment Value 2"), { target: { value: "eng" } });
    fireEvent.change(screen.getByLabelText("Host port 1"), { target: { value: "8020" } });
    fireEvent.click(screen.getByLabelText("Read-only 1"));
    fireEvent.change(screen.getByLabelText("When it stops"), { target: { value: "on-failure" } });
    fireEvent.change(screen.getByLabelText("Tries"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove com.docker.compose.project" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    const asked = screen.getByRole("group", {
      name: "Recreate paperless with these settings? It stops for a moment. In a Compose app, its file changes too.",
    });
    expect(sent).toEqual([]);
    fireEvent.click(within(asked).getByRole("button", { name: TEXT.yes }));
    await waitFor(() =>
      expect(sent).toEqual([
        {
          environment: [
            { name: "PAPERLESS_TIME_ZONE", value: "UTC" },
            { name: "PAPERLESS_OCR_LANGUAGE", value: "eng" },
          ],
          labels: [],
          ports: [{ target: 8000, protocol: "tcp", published: 8020, address: "" }],
          mounts: [{ kind: "bind", source: "/srv/paperless/data", target: "/usr/src/paperless/data", readOnly: true }],
          restart: { policy: "on-failure", retries: 3 },
        },
      ]),
    );
    expect(
      await screen.findByText(
        "Changed the settings of paperless, and it is running.",
        {},
        { timeout: FOLLOWED_LONG_ENOUGH },
      ),
    ).toBeTruthy();
  });

  it("says what its memory readings suggest for its limit, and warns when it keeps running out", async () => {
    serve(
      { error: null, settings },
      {
        memory: { percentileBytes: 800 * BYTES_PER_MEBIBYTE, suggestedBytes: 1024 * BYTES_PER_MEBIBYTE, buckets: 2016 },
        limitBytes: null,
        oomKills: 3,
      },
    );
    show();
    const note = await screen.findByRole("note");
    expect(note.textContent).toBe(
      "Over 7 days it used at most 839 MB of memory 99% of the time: a limit of 1.1 GB (mem_limit: 1024m) leaves room. " +
        "It has no memory limit now. It ran out of memory 3 times in 7 days.",
    );
    expect(note.className).toContain("warning");
  });

  it("says a limit waits for a day of readings, and says nothing of a limit it has not read", async () => {
    serve({ error: null, settings }, { memory: null, oomKills: 0 });
    show();
    const note = await screen.findByRole("note");
    expect(note.textContent).toBe("A limit is suggested once a day of its memory readings is in.");
    expect(note.className).not.toContain("warning");
  });

  it("says why when the runner could not read them", async () => {
    serve({ error: "Refused: this host's CONTAINER_ACCESS is not on.", settings: null });
    show();
    expect(await screen.findByText("Refused: this host's CONTAINER_ACCESS is not on.")).toBeTruthy();
  });
});
