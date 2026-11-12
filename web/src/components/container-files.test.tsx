import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileAnswer, FileEntry } from "../../../src/shared/protocol.js";
import { base64FromText, crumbsOf, textOf } from "../container-files.js";
import { TEXT } from "../constants.js";
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

// A name given where the button asked for it.
function give(question: string, name: string) {
  const asked = screen.getByRole("group", { name: question });
  fireEvent.change(within(asked).getByRole("textbox"), { target: { value: name } });
  fireEvent.click(within(asked).getByRole("button", { name: TEXT.askInPlace.save }));
}

describe("a container's files, in the dashboard", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    give(TEXT.files.askFolderName, "cache");
    await waitFor(() => expect(asked).toContainEqual({ operation: "make_folder", path: "/srv/cache" }));
    fireEvent.click(screen.getByRole("button", { name: "locked" }));
    expect(await screen.findByText("ls: /srv/locked/: Permission denied")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Up" }));
    fireEvent.click(await screen.findByRole("button", { name: "Up" }));
    expect(await screen.findByRole("button", { name: "zeta.txt" })).toBeTruthy();
  });

  describe("a file saved", () => {
    const opened = async () => {
      show();
      fireEvent.click(await screen.findByRole("button", { name: "app.env" }));
      return (await screen.findByRole("textbox", { name: "/app.env" })) as HTMLTextAreaElement;
    };
    const listing = answer({ entries: [entry("app.env", "file", 4)] });

    it("shows and downloads what it saved, not what it read before", async () => {
      serve({ "list /": listing, "read /app.env": answer({ content: base64FromText("A=1\n") }) });
      const saved: Blob[] = [];
      vi.stubGlobal(
        "URL",
        class extends URL {
          static override createObjectURL(blob: Blob) {
            saved.push(blob);
            return "blob:saved";
          }
          static override revokeObjectURL() {}
        },
      );
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
      const editor = await opened();

      fireEvent.change(editor, { target: { value: "A=2\n" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText("Saved")).toBeTruthy();

      expect(editor.value).toBe("A=2\n");
      const editorPanel = screen.getByRole("region", { name: "/app.env" });
      fireEvent.click(within(editorPanel).getByRole("button", { name: TEXT.files.download("app.env") }));
      expect(await saved[0]!.text()).toBe("A=2\n");
    });

    it("keeps an edit made while it was saving", async () => {
      const writing: { finish?: () => void } = {};
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          const { operation } = JSON.parse(String(init?.body)) as { operation: string };
          if (operation === "write") {
            await new Promise<void>((resolve) => {
              writing.finish = () => resolve();
            });
          }
          const given = { list: listing, read: answer({ content: base64FromText("A=1\n") }) }[operation];
          return new Response(JSON.stringify(given ?? answer({})), { headers: { "content-type": "application/json" } });
        }),
      );
      const editor = await opened();

      fireEvent.change(editor, { target: { value: "A=2\n" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(writing.finish).toBeDefined());
      fireEvent.change(editor, { target: { value: "A=3\n" } });
      writing.finish!();

      await waitFor(() =>
        expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false),
      );
      expect(editor.value).toBe("A=3\n");
      expect(screen.queryByText("Saved")).toBeNull();
    });
  });

  it("offers Upload as a button the keyboard reaches, opening the chooser, and waiting while a file is written", async () => {
    const writing: { finish?: () => void } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const { operation } = JSON.parse(String(init?.body)) as { operation: string };
        if (operation === "write") {
          await new Promise<void>((resolve) => {
            writing.finish = () => resolve();
          });
        }
        const given = operation === "list" ? answer({ entries: [entry("notes.txt", "file", 3)] }) : answer({});
        return new Response(JSON.stringify(given), { headers: { "content-type": "application/json" } });
      }),
    );
    const chooserOpened = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    show();
    await screen.findByRole("button", { name: "notes.txt" });

    const upload = screen.getByRole("button", { name: TEXT.files.upload }) as HTMLButtonElement;
    upload.focus();
    expect(document.activeElement).toBe(upload);
    fireEvent.click(upload);
    expect(chooserOpened).toHaveBeenCalledTimes(1);
    const chooser = chooserOpened.mock.contexts[0] as HTMLInputElement;
    expect(chooser.type).toBe("file");

    fireEvent.change(chooser, { target: { files: [new File(["hello"], "hello.txt")] } });
    await waitFor(() => expect(writing.finish).toBeDefined());
    expect(upload.disabled).toBe(true);
    writing.finish!();
    await waitFor(() => expect(upload.disabled).toBe(false));
  });

  it("renames, removes after asking, refuses a name with a slash, and uploads into the folder", async () => {
    const asked = serve({ "list /": answer({ entries: [entry("notes.txt", "file", 3)] }) });
    show();
    await screen.findByRole("button", { name: "notes.txt" });

    fireEvent.click(screen.getByRole("button", { name: "Rename notes.txt" }));
    give(TEXT.files.askNewName("notes.txt"), "a/b");
    expect(await screen.findByText("A name can't be empty, . or .., nor hold a /.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename notes.txt" }));
    give(TEXT.files.askNewName("notes.txt"), "todo.txt");
    await waitFor(() => expect(asked).toContainEqual({ operation: "rename", path: "/notes.txt", to: "/todo.txt" }));

    fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    const removing = screen.getByRole("group", { name: "Remove /notes.txt? A folder goes with everything in it." });
    fireEvent.click(within(removing).getByRole("button", { name: TEXT.yes }));
    await waitFor(() => expect(asked).toContainEqual({ operation: "remove", path: "/notes.txt" }));

    const upload = screen.getByLabelText("Upload");
    fireEvent.change(upload, { target: { files: [new File(["hello"], "hello.txt")] } });
    await waitFor(() =>
      expect(asked).toContainEqual({ operation: "write", path: "/hello.txt", content: base64FromText("hello") }),
    );
  });
});
