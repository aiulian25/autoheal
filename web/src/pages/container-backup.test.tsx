import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import { JOB_STATUS } from "../../../src/shared/constants.js";
import type { BackupAnswer, BackupEntry } from "../../../src/shared/container-backups.js";
import { TEXT } from "../constants.js";
import { BACKUP_DIALOG, BackupDialog, type BackupDialogMode } from "./container-backup.js";

const text = TEXT.containerBackup;
const HOST = "h1";
const TARGET = { container: "wikijs", stack: null };
const GIB = 1024 ** 3;

const PREVIEW: BackupAnswer = {
  refusal: null,
  preview: {
    mounts: [
      { member: "wikijs", source: "/srv/wiki", target: "/config", bytes: 400_000_000, leftOut: null },
      { member: "wikijs", source: "/mnt/media", target: "/media", bytes: 60 * GIB, leftOut: "large" },
      { member: "wikijs", source: "/mnt/huge", target: "/huge", bytes: 900 * GIB, leftOut: "no_room" },
    ],
    dumps: [],
    stops: ["wikijs"],
    savesSettings: true,
    directory: "/var/backups/autoheal",
    freeBytes: 112 * GIB,
  },
};
const backup = (id: string, over: Partial<BackupEntry> = {}): BackupEntry => ({
  id,
  createdAt: 1_700_000_000_000,
  why: "asked",
  bytes: 400_000_000,
  fromStack: false,
  members: [{ name: "wikijs", image: "wikijs:2", method: "files", sameImage: true }],
  hasSettings: true,
  leftOut: [],
  unsealed: false,
  ...over,
});

let answer: BackupAnswer;
let sent: { url: string; body: unknown }[];
let job: object;

beforeEach(() => {
  sent = [];
  job = { id: "j1", status: JOB_STATUS.delivered, progress: null, outcome: null };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      const body = init?.body === undefined ? null : (JSON.parse(String(init.body)) as unknown);
      if (url === apiPath(API_ROUTES.hostBackupAsk, { hostId: HOST })) return json(answer);
      if (url === apiPath(API_ROUTES.job, { jobId: "j1" })) return json(job);
      sent.push({ url, body });
      return json(job);
    }),
  );
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (mode: BackupDialogMode, target: typeof TARGET | { container: null; stack: string } = TARGET) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BackupDialog hostId={HOST} target={target} mode={mode} onClose={() => undefined} />
    </QueryClientProvider>,
  );

describe("backing up", () => {
  it("says what it will save, how, and where, before anything happens", async () => {
    answer = PREVIEW;
    show(BACKUP_DIALOG.backUp);
    expect(await screen.findByText(text.stopsItself)).toBeTruthy();
    expect(screen.getByText("/srv/wiki")).toBeTruthy();
    expect(screen.getByText(text.composeAndImage)).toBeTruthy();
    expect(screen.getByText("/var/backups/autoheal/wikijs")).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it("leaves a large folder out unless ticked, and will not let one that cannot fit be ticked", async () => {
    answer = PREVIEW;
    show(BACKUP_DIALOG.backUp);
    const [large, huge] = (await screen.findAllByRole("checkbox")) as HTMLInputElement[];
    expect(large!.checked).toBe(false);
    expect(huge!.disabled).toBe(true);
    fireEvent.click(large!);
    fireEvent.click(screen.getByRole("button", { name: text.backUpNow }));
    await waitFor(() => expect(sent[0]?.body).toEqual({ target: TARGET, include: ["/mnt/media"] }));
  });

  it("names who else stops", async () => {
    answer = { refusal: null, preview: { ...PREVIEW.preview!, stops: ["wikijs", "sharer"] } };
    show(BACKUP_DIALOG.backUp);
    expect(await screen.findByText(text.stopsThese("wikijs, sharer"))).toBeTruthy();
  });

  it("says a database keeps running", async () => {
    answer = {
      refusal: null,
      preview: { ...PREVIEW.preview!, mounts: [], stops: [], dumps: [{ member: "db", engine: "PostgreSQL" }] },
    };
    show(BACKUP_DIALOG.backUp);
    expect(await screen.findByText(text.keepsRunning("PostgreSQL"))).toBeTruthy();
    expect(screen.getByText(text.databaseSaved("PostgreSQL"))).toBeTruthy();
  });

  it("gives its refusal in its own words, with nothing to press", async () => {
    answer = { refusal: "This has no data of its own to save." };
    show(BACKUP_DIALOG.backUp);
    expect(await screen.findByText(answer.refusal!)).toBeTruthy();
    expect(screen.queryByRole("button", { name: text.backUpNow })).toBeNull();
  });

  it("shows how it is going, then how it went", async () => {
    answer = PREVIEW;
    job = { ...job, progress: { phase: "copying", downloaded: 50, total: 100, layers: [], log: [] } };
    show(BACKUP_DIALOG.backUp);
    fireEvent.click(await screen.findByRole("button", { name: text.backUpNow }));
    expect(await screen.findByText(TEXT.updateStream.phases.copying)).toBeTruthy();
    expect(screen.getByText(text.canClose)).toBeTruthy();
  });

  it("shows a failure plainly", async () => {
    answer = PREVIEW;
    job = { ...job, status: JOB_STATUS.failed, outcome: "The disk is full." };
    show(BACKUP_DIALOG.backUp);
    fireEvent.click(await screen.findByRole("button", { name: text.backUpNow }));
    expect(await screen.findByText("The disk is full.")).toBeTruthy();
  });
});

describe("restoring", () => {
  it("says so when there are none", async () => {
    answer = { refusal: null, backups: [] };
    show(BACKUP_DIALOG.restore);
    expect(await screen.findByText(text.noBackups)).toBeTruthy();
    expect(screen.queryByRole("button", { name: text.restoreThis })).toBeNull();
  });

  it("still offers the good ones when one cannot be read, and says which, offering it nowhere", async () => {
    answer = {
      refusal: null,
      backups: [backup("20261102T000000Z")],
      unreadable: [{ folder: "wikijs", id: "20261101T000000Z", reason: "not_json" }],
      unreadableCount: 1,
    };
    show(BACKUP_DIALOG.restore);
    expect(await screen.findAllByRole("radio")).toHaveLength(1);
    expect(screen.getByText(text.unreadable(1))).toBeTruthy();
    expect(screen.getByText(`wikijs/20261101T000000Z: ${text.unreadableWhy.not_json}`)).toBeTruthy();
    expect(screen.queryByText(text.noBackups)).toBeNull();
  });

  it("does not say there are none when the only ones cannot be read", async () => {
    answer = {
      refusal: null,
      backups: [],
      unreadable: [{ folder: "wikijs", id: "20261101T000000Z", reason: "too_big" }],
      unreadableCount: 3,
    };
    show(BACKUP_DIALOG.restore);
    expect(await screen.findByText(text.unreadable(3))).toBeTruthy();
    expect(screen.getByText(text.unreadableMore(2))).toBeTruthy();
    expect(screen.queryByText(text.noBackups)).toBeNull();
    expect(screen.queryByRole("button", { name: text.restoreThis })).toBeNull();
  });

  it("picks the newest, says what is lost, and restores what was chosen", async () => {
    answer = { refusal: null, backups: [backup("20261102T000000Z"), backup("20261101T000000Z")] };
    show(BACKUP_DIALOG.restore);
    const radios = (await screen.findAllByRole("radio")) as HTMLInputElement[];
    expect(radios[0]!.checked).toBe(true);
    expect(screen.getByText(text.whatIsLost("wikijs"))).toBeTruthy();
    fireEvent.click(radios[1]!);
    fireEvent.click(screen.getByRole("button", { name: text.restoreThis }));
    await waitFor(() => expect(sent[0]?.body).toEqual({ target: TARGET, id: "20261101T000000Z" }));
  });

  it("offers an older unsealed backup only by hand, and picks the newest it can restore", async () => {
    answer = {
      refusal: null,
      backups: [backup("20261102T000000Z", { unsealed: true }), backup("20261101T000000Z")],
    };
    show(BACKUP_DIALOG.restore);
    const [older, usable] = (await screen.findAllByRole("radio")) as HTMLInputElement[];
    expect(older!.disabled).toBe(true);
    expect(older!.checked).toBe(false);
    expect(usable!.checked).toBe(true);
    expect(screen.getByText(text.notSealed)).toBeTruthy();
  });

  it("has nothing to press when no backup can be restored here", async () => {
    answer = { refusal: null, backups: [backup("20261102T000000Z", { unsealed: true })] };
    show(BACKUP_DIALOG.restore);
    await screen.findByText(text.notSealed);
    expect(screen.queryByRole("button", { name: text.restoreThis })).toBeNull();
  });

  it("warns of an older version", async () => {
    answer = {
      refusal: null,
      backups: [
        backup("20261101T000000Z", {
          members: [{ name: "wikijs", image: "wikijs:1", method: "files", sameImage: false }],
        }),
      ],
    };
    show(BACKUP_DIALOG.restore);
    expect(await screen.findByText(text.olderImageCompose("wikijs:1"))).toBeTruthy();
  });

  it("warns that one of a stack may come back out of step", async () => {
    answer = {
      refusal: null,
      backups: [backup("20261101T000000Z", { fromStack: true, hasSettings: false })],
    };
    show(BACKUP_DIALOG.restore);
    expect(await screen.findByText(text.oneOfStack("wikijs"))).toBeTruthy();
  });

  describe("how a finished restore reads", () => {
    const ended = async (over: Partial<BackupEntry>, result: Partial<typeof job>) => {
      answer = { refusal: null, backups: [backup("20261101T000000Z", over)] };
      job = { ...job, status: JOB_STATUS.succeeded, outcome: "Restored.", ...result };
      show(BACKUP_DIALOG.restore);
      fireEvent.click((await screen.findAllByRole("radio")).at(-1)!);
      fireEvent.click(screen.getByRole("button", { name: text.restoreThis }));
      return (await screen.findByText(/Restored|did not finish/)).className;
    };

    it("reads as done when everything it was asked for came back", async () => {
      expect(await ended({}, {})).toBe("text-good");
    });

    it("does not read as a plain tick when only the data came back", async () => {
      // One of a stack, whose Compose files are deliberately left: a success, but its stack is not as it was.
      expect(await ended({ fromStack: true }, {})).toBe("notice");
    });

    it("reads as unfinished when a part of it could not be put back", async () => {
      const style = await ended({}, { status: JOB_STATUS.failed, outcome: "The data is back, but it did not finish." });
      expect(style).toBe("notice warning");
    });
  });

  it("says the stack's Compose files stay as they are, since they speak for its other services too", async () => {
    answer = { refusal: null, backups: [backup("20261101T000000Z", { fromStack: true })] };
    show(BACKUP_DIALOG.restore);
    expect(await screen.findByText(text.oneOfStackCompose("wikijs"))).toBeTruthy();
    expect(screen.queryByText(text.oneOfStack("wikijs"))).toBeNull();
  });

  describe("going back from a restore", () => {
    const OWN_COPY = "20261102T000000Z";
    const NEWER_COPY = "20261103T000000Z";
    const CHOSEN = "20261101T000000Z";
    const restored = async () => {
      show(BACKUP_DIALOG.restore);
      fireEvent.click((await screen.findAllByRole("radio")).at(-1)!);
      fireEvent.click(screen.getByRole("button", { name: text.restoreThis }));
      await screen.findByText(/Restored/);
    };

    it("goes back to this restore's own copy, though a newer one is listed", async () => {
      const takenAt = Date.UTC(2026, 10, 2, 9, 30);
      answer = {
        refusal: null,
        backups: [
          backup(NEWER_COPY, { why: "safety" }),
          backup(OWN_COPY, { why: "safety", createdAt: takenAt }),
          backup(CHOSEN),
        ],
      };
      job = { ...job, status: JOB_STATUS.succeeded, outcome: "Restored.", recoveryBackupId: OWN_COPY };
      await restored();
      expect(await screen.findByText(text.undoTo(new Date(takenAt).toLocaleString()))).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: text.undo }));
      await waitFor(() => expect(sent[1]?.body).toEqual({ target: TARGET, id: OWN_COPY }));
    });

    it.each([
      ["failed before its copy was made", { status: JOB_STATUS.failed, recoveryBackupId: null }],
      ["was made by a version that does not say", { status: JOB_STATUS.succeeded, recoveryBackupId: null }],
      ["has a copy that is gone by now", { status: JOB_STATUS.succeeded, recoveryBackupId: "20261030T000000Z" }],
      ["names a backup that is not a safety copy", { status: JOB_STATUS.succeeded, recoveryBackupId: CHOSEN }],
    ])("offers no way back from a restore that %s, whatever else is listed", async (_case, result) => {
      answer = { refusal: null, backups: [backup(NEWER_COPY, { why: "safety" }), backup(CHOSEN)] };
      job = { ...job, outcome: "Restored.", ...result };
      await restored();
      expect(screen.queryByRole("button", { name: text.undo })).toBeNull();
    });
  });
});
