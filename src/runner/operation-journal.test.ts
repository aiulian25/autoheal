import { describe, expect, it } from "vitest";
import { OperationJournal } from "./operation-journal.js";
function journalStore() {
  const volumes = new Map<string, { Name: string; Labels: Record<string, string> }>();
  const store = {
    createVolume: async (name: string, labels: Record<string, string>) => {
      if (!volumes.has(name)) volumes.set(name, { Name: name, Labels: labels });
    },
    volumes: async (filter: string) => {
      const [key, value] = filter.split("=");
      return [...volumes.values()].filter(({ Labels }) =>
        value === undefined ? Labels[key!] !== undefined : Labels[key!] === value,
      );
    },
    removeVolume: async (name: string) => {
      volumes.delete(name);
    },
  };
  return { store, volumes };
}
const members = [{ name: "app", id: "original", replacementId: "replacement", running: true, restore: true }];
describe("rollback operation journal", () => {
  it("survives reconstruction and resolves original/replacement identity through monotonic phases", async () => {
    const { store } = journalStore();
    const journal = new OperationJournal(store);
    const record = await journal.begin("app", members, null);
    await journal.save(record, "restored");
    const restarted = new OperationJournal(store);
    expect(await restarted.find("original")).toMatchObject({ phase: "restored" });
    expect(await restarted.find("alias", "replacement")).toMatchObject({ owner: "app" });
    await restarted.complete(record);
    expect(await new OperationJournal(store).pending()).toEqual([]);
  });
  it("does not lose the committed tombstone if older-record cleanup fails", async () => {
    const { store, volumes } = journalStore();
    const journal = new OperationJournal(store);
    const record = await journal.begin("app", members, null);
    store.removeVolume = async () => {
      throw new Error("disk busy");
    };
    await journal.complete(record);
    expect(volumes.size).toBe(2);
    expect(await new OperationJournal(store).pending()).toEqual([]);
  });
  it("retains the tombstone if cleanup listing fails", async () => {
    const { store } = journalStore();
    const journal = new OperationJournal(store);
    const record = await journal.begin("app", members, null);
    const list = store.volumes;
    store.volumes = async () => {
      throw new Error("unavailable");
    };
    await journal.complete(record);
    store.volumes = list;
    expect(await new OperationJournal(store).pending()).toEqual([]);
  });
  it("fails closed on corrupt records and failed publication", async () => {
    const { store, volumes } = journalStore();
    const journal = new OperationJournal(store);
    await journal.begin("app", members, null);
    [...volumes.values()][0]!.Labels["autoheal.rollback.record"] = "bad json";
    await expect(journal.find("app")).rejects.toThrow();
    volumes.clear();
    store.createVolume = async () => {
      throw new Error("full disk");
    };
    await expect(journal.begin("app", members, null)).rejects.toThrow("full disk");
  });
  it("fails closed on unknown versions and inconsistent phase identities", async () => {
    const { store, volumes } = journalStore();
    const journal = new OperationJournal(store);
    const record = await journal.begin("app", members, null);
    const prepared = [...volumes.values()][0]!;
    prepared.Labels["autoheal.rollback.journal"] = "2";
    await expect(journal.pending()).rejects.toThrow("Unsupported");
    prepared.Labels["autoheal.rollback.journal"] = "1";
    await journal.save(record, "restored");
    const latest = [...volumes.values()][1]!;
    const changed = JSON.parse(latest.Labels["autoheal.rollback.record"]!);
    changed.members[0].id = "wrong-original";
    latest.Labels["autoheal.rollback.record"] = JSON.stringify(changed);
    await expect(journal.pending()).rejects.toThrow("disagree");
  });

  it("refuses overlapping ownership", async () => {
    const { store } = journalStore();
    const journal = new OperationJournal(store);
    await journal.begin("app", members, null);
    await expect(journal.begin("other", [{ ...members[0]!, name: "other" }], null)).rejects.toThrow("already owns");
  });
});
