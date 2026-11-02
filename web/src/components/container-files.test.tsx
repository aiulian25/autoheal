import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileAnswer, FileEntry } from "../../../src/shared/protocol.js";
import { base64FromText, crumbsOf, textOf } from "../container-files.js";
import { ContainerFiles } from "./container-files.js";

const FILES = "/api/inventory/hosts/h1/containers/paperless/files";
const NOT_FOUND = 404;

const entry = (name: string, kind: FileEntry["kind"], size = 0): FileEntry => ({
  name,
  kind,
  size,
  mode: kind === "folder" ? "drwxr-xr-x" : "-rw-r--r--",
  owner: "root",
  group: "root",
  modified: "Oct 24 13:13",
  linkTarget: null,
});

const answer = (fields: Partial<FileAnswer>): FileAnswer => ({
  error: null,
  entries: null,
  truncated: false,
  content: null,
  ...fields,
});

// The runner's answers, by operation and path; every request is kept to look at.
function serve(answers: Record<string, FileAnswer>) {
  const asked: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== FILES) {
        return new Response(null, { status: NOT_FOUND });
      }
      const body = JSON.parse(String(init?.body)) as { operation: string; path: string };
      asked.push(body);
      const given = answers[`${body.operation} ${body.path}`] ?? answer({});
      return new Response(JSON.stringify(given), { headers: { "content-type": "application/json" } });
    }),
  );
  return asked;
}

function show() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <ContainerFiles hostId="h1" containerName="paperless" onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe("a container's files, in the dashboard", () => {
  beforeEach(() => vi.spyOn(window, "confirm").mockReturnValue(true));

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("knows paths, text and bytes", () => {
    expect(crumbsOf("/srv/app/config")).toEqual([
      { name: "srv", path: "/srv" },
      { name: "app", path: "/srv/app" },
      { name: "config", path: "/srv/app/config" },
    ]);
    expect(crumbsOf("/")).toEqual([]);
    expect(textOf(base64FromText("héllo\n"))).toBe("héllo\n");
    expect(textOf(btoa("ÿþ\u0000"))).toBeNull();
  });

  it("walks folders, folders first, opens a file to change and save, and says what the runner refused", async () => {
    const asked = serve({
      "list /": answer({ entries: [entry("zeta.txt", "file", 5), entry("srv", "folder")] }),
      "list /srv": answer({ entries: [entry("app.env", "file", 4), entry("locked", "folder")] }),
      "read /srv/app.env": answer({ content: base64FromText("A=1\n") }),
      "list /srv/locked": answer({ error: "ls: /srv/locked/: Permission denied" }),
    });
    show();

    const rows = await screen.findAllByRole("row");
    expect(rows.slice(1).map((row) => within(row).getAllByRole("cell")[0]!.textContent)).toEqual(["srv", "zeta.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "srv" }));
    fireEvent.click(await screen.findByRole("button", { name: "app.env" }));

    const editor = await screen.findByRole("textbox", { name: "/srv/app.env" });
    expect((editor as HTMLTextAreaElement).value).toBe("A=1\n");
    fireEvent.change(editor, { target: { value: "A=2\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(asked).toContainEqual({ operation: "write", path: "/srv/app.env", content: base64FromText("A=2\n") }),
    );
    expect(await screen.findByText("Saved")).toBeTruthy();

    vi.spyOn(window, "prompt").mockReturnValue("cache");
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    await waitFor(() => expect(asked).toContainEqual({ operation: "make_folder", path: "/srv/cache" }));
    fireEvent.click(screen.getByRole("button", { name: "locked" }));
    expect(await screen.findByText("ls: /srv/locked/: Permission denied")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    fireEvent.click(await screen.findByRole("button", { name: "Up" }));
    expect(await screen.findByRole("button", { name: "zeta.txt" })).toBeTruthy();
  });

  it("renames, removes after asking, refuses a name with a slash, and uploads into the folder", async () => {
    const asked = serve({ "list /": answer({ entries: [entry("notes.txt", "file", 3)] }) });
    show();
    await screen.findByRole("button", { name: "notes.txt" });

    vi.spyOn(window, "prompt").mockReturnValueOnce("a/b").mockReturnValueOnce("todo.txt");
    fireEvent.click(screen.getByRole("button", { name: "Rename notes.txt" }));
    expect(await screen.findByText("A name can't be empty, . or .., nor hold a /.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename notes.txt" }));
    await waitFor(() => expect(asked).toContainEqual({ operation: "rename", path: "/notes.txt", to: "/todo.txt" }));

    fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    expect(window.confirm).toHaveBeenCalledWith("Remove /notes.txt? A folder goes with everything in it.");
    await waitFor(() => expect(asked).toContainEqual({ operation: "remove", path: "/notes.txt" }));

    const upload = screen.getByLabelText("Upload");
    fireEvent.change(upload, { target: { files: [new File(["hello"], "hello.txt")] } });
    await waitFor(() =>
      expect(asked).toContainEqual({ operation: "write", path: "/hello.txt", content: base64FromText("hello") }),
    );
  });
});
