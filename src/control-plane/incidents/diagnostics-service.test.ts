import { describe, expect, it, vi } from "vitest";
import type { IncidentDetailView } from "../../shared/api.js";
import { DIAGNOSTIC_MAX_BYTES, DIAGNOSTIC_TTL_MILLISECONDS } from "../../shared/diagnostics.js";
import { sha256Hex } from "../../shared/hash.js";
import { diagnosticBundle, DiagnosticsService } from "./diagnostics-service.js";

const SECRET = "synthetic-unknown-opaque-secret-with-no-recognizable-pattern";
const CORPUS = [
  SECRET,
  "password=hunter2-hunter2",
  "Bearer eyJhbGciOiJSUzI1NiJ9.secret.signature",
  "-----BEGIN PRIVATE KEY-----abcdef-----END PRIVATE KEY-----",
  "postgres://user:syntheticpassword@private-host/private-db",
];
const TEXT = CORPUS.join("\n");
const NOW = Date.UTC(2026, 9, 27);
const actor = { userId: "operator", username: "admin", ip: "127.0.0.1", requestId: "r1" };
const incident = (): IncidentDetailView => ({
  id: SECRET,
  hostId: SECRET,
  hostLabel: TEXT,
  containerName: TEXT,
  image: TEXT,
  trigger: "die",
  status: "resolved",
  decidedBy: TEXT,
  action: "restart",
  target: TEXT,
  verdict: TEXT,
  detectedAt: NOW,
  updatedAt: NOW,
  diagnosis: TEXT,
  outcome: TEXT,
  promptHash: TEXT,
  modelName: TEXT,
  modelDigest: TEXT,
  reasoning: TEXT,
  report: {
    stateSummary: `status=exited ${TEXT}`,
    healthOutputs: [TEXT],
    knownContainers: [TEXT],
    protectedContainers: [TEXT],
    logs: TEXT,
    composeProject: TEXT,
    neighbours: [{ name: TEXT, status: TEXT, logs: TEXT }],
  },
  trace: [
    { id: 1, kind: "reported", createdAt: NOW, payload: { logs: TEXT, environment: TEXT, session: TEXT } },
    { id: 2, kind: TEXT, createdAt: NOW, payload: { text: TEXT } },
  ],
  approvals: [{ id: TEXT, choice: "restart", target: TEXT, note: TEXT, decidedBy: TEXT, decidedAt: NOW }],
  earlier: [],
  evidence: [TEXT],
  usage: [],
});

describe("incident diagnostic bundles", () => {
  it("omits the complete synthetic secret corpus, including unrecognizable secrets, from every free-text boundary", () => {
    const bundle = diagnosticBundle(incident(), ["trace", "facts", "usage"], NOW);
    const bytes = JSON.stringify(bundle);
    for (const secret of CORPUS) expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain("private-host");
    expect(bundle.evidence.trace).toEqual([
      { kind: "reported", at: NOW },
      { kind: "other", at: NOW },
    ]);
    expect(bundle.evidence.facts).toMatchObject({
      host: "host-1",
      container: "container-1",
      state: "exited",
      protectedContainer: true,
    });
    expect(bundle.manifest.sha256).toBe(sha256Hex(JSON.stringify(bundle.evidence)));
  });
  it("honours content choices, is deterministic and bounds captured trace and usage", () => {
    const detail = incident();
    detail.trace = Array.from({ length: 501 }, (_, id) => ({ id, kind: "reported", payload: {}, createdAt: NOW + id }));
    const numericPoint = { at: NOW, cpuPercent: 10, memoryBytes: 1024 } as IncidentDetailView["usage"][number];
    detail.usage = Array.from({ length: 61 }, () => ({ ...numericPoint, name: SECRET }));
    const bundle = diagnosticBundle(detail, ["trace", "usage"], NOW);
    expect(bundle).toEqual(diagnosticBundle(detail, ["trace", "usage"], NOW));
    expect(bundle.evidence.facts).toBeUndefined();
    expect(bundle.evidence.trace).toHaveLength(500);
    expect(bundle.evidence.usage).toHaveLength(60);
    expect(bundle.manifest).toMatchObject({ truncatedTrace: true, truncatedUsage: true });
    expect(Buffer.byteLength(JSON.stringify(bundle))).toBeLessThan(DIAGNOSTIC_MAX_BYTES);
    expect(JSON.stringify(bundle)).not.toContain(SECRET);
    expect(() => diagnosticBundle(detail, ["trace", "trace"], NOW)).toThrow();
  });
  it("binds one-time exports to a live session, preserves preview bytes and audits only metadata", () => {
    const exported = vi.fn();
    const service = new DiagnosticsService({ detail: () => incident() }, exported, () => NOW);
    const preview = service.preview("session-a", "incident-1", ["facts"]);
    expect(() => service.download(actor, "session-b", "incident-1", preview.id)).toThrow("expired");
    expect(() => service.download(actor, "session-a", "incident-2", preview.id)).toThrow("expired");
    preview.bundle.evidence.facts!.host = "tampered" as "host-1";
    const result = service.download(actor, "session-a", "incident-1", preview.id);
    const downloaded = JSON.parse(result.text);
    expect(downloaded.evidence.facts.host).toBe("host-1");
    expect(downloaded.manifest.sha256).toBe(sha256Hex(JSON.stringify(downloaded.evidence)));
    expect(Buffer.byteLength(result.text)).toBe(preview.byteLength);
    expect(exported).toHaveBeenCalledExactlyOnceWith(actor, "incident-1", {
      bundleId: preview.id,
      bytes: preview.byteLength,
      sections: ["facts"],
    });
    expect(() => service.download(actor, "session-a", "incident-1", preview.id)).toThrow("expired");
  });
  it("caps preview retention, expires it and rejects clock rollback or a lost incident read scope", () => {
    let now = NOW;
    let allowed = true;
    const detail = () => {
      if (!allowed) throw new Error("read scope revoked");
      return incident();
    };
    const exported = vi.fn();
    const service = new DiagnosticsService({ detail }, exported, () => now);
    for (let index = 0; index < 64; index++) service.preview("session", "incident", ["trace"]);
    expect(() => service.preview("session", "incident", ["trace"])).toThrow("full");
    now += DIAGNOSTIC_TTL_MILLISECONDS;
    const preview = service.preview("session", "incident", ["trace"]);
    allowed = false;
    expect(() => service.download(actor, "session", "incident", preview.id)).toThrow("read scope revoked");
    expect(exported).not.toHaveBeenCalled();
    allowed = true;
    now--;
    expect(() => service.download(actor, "session", "incident", preview.id)).toThrow("expired");
    service.reset();
  });
});
