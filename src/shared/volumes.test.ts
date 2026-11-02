import { describe, expect, it } from "vitest";
import {
  VOLUME_STATE,
  isCleanableVolume,
  isRemovableVolume,
  newVolumeSchema,
  volumeState,
  type VolumeReport,
} from "./volumes.js";

const volume = (overrides: Partial<VolumeReport>): VolumeReport => ({
  name: "936121521c03",
  driver: "local",
  sizeBytes: 0,
  createdAt: "",
  nameless: true,
  project: null,
  projectHere: false,
  own: false,
  ownedBy: null,
  members: [],
  ...overrides,
});
const running = { name: "app", running: true, destination: "/data" };
const stopped = { name: "app", running: false, destination: "/data" };

describe("what a volume is", () => {
  it.each([
    ["nameless, with nothing using it", {}, VOLUME_STATE.leftBehind],
    ["Compose made it and its containers are gone", { nameless: false, project: "charon" }, VOLUME_STATE.leftBehind],
    ["its app is still here", { nameless: false, project: "x", projectHere: true }, VOLUME_STATE.projectStillHere],
    ["it has a name and nothing says whose", { nameless: false }, VOLUME_STATE.notUsed],
    ["another tool's", { nameless: false, ownedBy: "Other Tool" }, VOLUME_STATE.otherTool],
    ["something runs on it", { members: [running] }, VOLUME_STATE.inUse],
    ["only a stopped container has it", { members: [stopped] }, VOLUME_STATE.keptForStopped],
    ["Autoheal's own, though it looks empty", { own: true }, VOLUME_STATE.autohealOwn],
  ])("says so when %s", (_case, overrides, state) => {
    expect(volumeState(volume(overrides))).toBe(state);
  });

  it("cleans up without a question only what is nameless, unattached and known to be empty", () => {
    expect(isCleanableVolume(volume({}))).toBe(true);
    expect(isCleanableVolume(volume({ sizeBytes: 1 }))).toBe(false);
    expect(isCleanableVolume(volume({ sizeBytes: null }))).toBe(false);
    expect(isCleanableVolume(volume({ nameless: false, project: "charon" }))).toBe(false);
    expect(isCleanableVolume(volume({ own: true }))).toBe(false);
    expect(isCleanableVolume(volume({ ownedBy: "Other Tool" }))).toBe(false);
    expect(isCleanableVolume(volume({ members: [stopped] }))).toBe(false);
  });

  it("lets a person remove only what nothing is attached to and is not Autoheal's", () => {
    expect(isRemovableVolume(volume({ sizeBytes: 5, ownedBy: "Other Tool" }))).toBe(true);
    expect(isRemovableVolume(volume({ own: true }))).toBe(false);
    expect(isRemovableVolume(volume({ members: [stopped] }))).toBe(false);
  });
});

describe("a new volume", () => {
  it("takes a share's address and path only as themselves, so neither can add mount options", () => {
    const share = (address: string, path: string) =>
      newVolumeSchema.safeParse({ name: "nas", share: { kind: "nfs", address, path } }).success;
    expect(share("192.168.10.5", "/export/media")).toBe(true);
    expect(share("nas.local,uid=0", "/export")).toBe(false);
    expect(share("nas.local", "/export,rw")).toBe(false);
    expect(share("nas.local", "relative")).toBe(false);
  });
});
