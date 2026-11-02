import { randomUUID } from "node:crypto";
import type { IncidentDetailView } from "../../shared/api.js";
import { ALLOWED_ACTIONS, INCIDENT_STATUSES, TRACE, TRIGGERS } from "../../shared/constants.js";
import {
  DIAGNOSTIC_MAX_BYTES,
  DIAGNOSTIC_TTL_MILLISECONDS,
  diagnosticSectionsSchema,
  type DiagnosticBundle,
  type DiagnosticPreview,
  type DiagnosticSection,
} from "../../shared/diagnostics.js";
import { sha256Hex } from "../../shared/hash.js";
import type { Actor } from "../audit/audit-log.js";
import type { IncidentsService } from "./incidents-service.js";

const MAX_PREVIEWS = 64;
const MAX_TRACE = 500;
const MAX_USAGE = 60;
const known = (value: unknown, choices: readonly string[]) =>
  typeof value === "string" && choices.includes(value) ? value : null;
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const USAGE_FIELDS = [
  "at",
  "cpuPercent",
  "cpuLimitCores",
  "throttledPercent",
  "memoryBytes",
  "memoryPercent",
  "memoryLimitBytes",
  "cacheBytes",
  "readBytesPerSecond",
  "writeBytesPerSecond",
  "receiveBytesPerSecond",
  "transmitBytesPerSecond",
  "droppedPackets",
  "processes",
] as const;

/** An allowlist, not a best-effort regex over arbitrary application/model text. */
export function diagnosticBundle(
  incident: IncidentDetailView,
  selected: readonly DiagnosticSection[],
  generatedAt: number,
): DiagnosticBundle {
  const sections = diagnosticSectionsSchema.parse(selected);
  const evidence: DiagnosticBundle["evidence"] = {
    incident: {
      detectedAt: number(incident.detectedAt),
      updatedAt: number(incident.updatedAt),
      trigger: known(incident.trigger, TRIGGERS),
      status: known(incident.status, INCIDENT_STATUSES),
      action: known(incident.action, ALLOWED_ACTIONS),
    },
  };
  if (sections.includes("trace"))
    evidence.trace = incident.trace
      .slice(-MAX_TRACE)
      .map((event) => ({ kind: known(event.kind, Object.values(TRACE)) ?? "other", at: number(event.createdAt) }));
  if (sections.includes("facts"))
    evidence.facts = {
      host: "host-1",
      container: "container-1",
      capturedReport: incident.report !== null,
      capturedNeighbours: incident.report?.neighbours.length ?? 0,
      protectedContainer: incident.report?.protectedContainers.includes(incident.containerName) ?? false,
      state:
        /(?:^|\s)status=(created|running|paused|restarting|removing|exited|dead)(?:\s|$)/.exec(
          incident.report?.stateSummary ?? "",
        )?.[1] ?? null,
      imageFingerprint: sha256Hex(incident.image),
    };
  if (sections.includes("usage"))
    evidence.usage = incident.usage
      .slice(-MAX_USAGE)
      .map((point) => Object.fromEntries(USAGE_FIELDS.map((field) => [field, number(point[field])])));
  return {
    format: "autoheal-diagnostics",
    version: 1,
    generatedAt,
    evidence,
    manifest: {
      sections,
      sha256: sha256Hex(JSON.stringify(evidence)),
      checksumEncoding: "UTF-8 JSON.stringify(evidence)",
      redaction: [
        "Only allowlisted enum, timestamp and numeric fields are included.",
        "Host and container names are replaced by bundle-local aliases; the image reference is fingerprinted.",
        "Raw logs, health text, trace payloads, model text, prompts, environment values, terminal output, addresses, accounts and unrelated resources are excluded.",
        "Captured evidence only; no runner collection or application mutation is performed.",
      ],
      truncatedTrace: sections.includes("trace") && incident.trace.length > MAX_TRACE,
      truncatedUsage: sections.includes("usage") && incident.usage.length > MAX_USAGE,
    },
  };
}
export class DiagnosticError extends Error {
  constructor(readonly reason: "expired" | "full") {
    super(reason);
  }
}
interface Prepared {
  session: string;
  preview: DiagnosticPreview;
  text: string;
  createdAt: number;
}
export class DiagnosticsService {
  private readonly prepared = new Map<string, Prepared>();
  constructor(
    private readonly incidents: Pick<IncidentsService, "detail">,
    private readonly exported: (
      actor: Actor,
      incidentId: string,
      metadata: { bundleId: string; bytes: number; sections: DiagnosticSection[] },
    ) => void,
    private readonly clock = Date.now,
  ) {}
  reset() {
    this.prepared.clear();
  }
  private expire() {
    const now = this.clock();
    for (const [id, item] of this.prepared)
      if (now >= item.preview.expiresAt || now < item.createdAt) this.prepared.delete(id);
  }
  preview(session: string, incidentId: string, sections: readonly DiagnosticSection[]): DiagnosticPreview {
    this.expire();
    if (this.prepared.size >= MAX_PREVIEWS) throw new DiagnosticError("full");
    const now = this.clock();
    const bundle = diagnosticBundle(this.incidents.detail(incidentId), sections, now);
    const text = JSON.stringify(bundle, null, 2) + "\n";
    const byteLength = Buffer.byteLength(text);
    if (byteLength > DIAGNOSTIC_MAX_BYTES) throw new DiagnosticError("full");
    const preview = { id: randomUUID(), incidentId, expiresAt: now + DIAGNOSTIC_TTL_MILLISECONDS, byteLength, bundle };
    this.prepared.set(preview.id, { session, preview, text, createdAt: now });
    return structuredClone(preview);
  }
  download(actor: Actor, session: string, incidentId: string, id: string) {
    this.expire();
    const item = this.prepared.get(id);
    if (!item || item.session !== session || item.preview.incidentId !== incidentId)
      throw new DiagnosticError("expired");
    // Re-read through the incident boundary: export must not survive deletion or a changed read scope.
    this.incidents.detail(incidentId);
    this.exported(actor, incidentId, {
      bundleId: id,
      bytes: item.preview.byteLength,
      sections: item.preview.bundle.manifest.sections,
    });
    this.prepared.delete(id);
    return { text: item.text, fileName: `autoheal-diagnostics-${id}.json` };
  }
}
