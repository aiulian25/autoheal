import { z } from "zod";

export const DIAGNOSTIC_SECTIONS = ["trace", "facts", "usage"] as const;
export const diagnosticSectionsSchema = z
  .array(z.enum(DIAGNOSTIC_SECTIONS))
  .min(1)
  .max(3)
  .refine((sections) => new Set(sections).size === sections.length);
export type DiagnosticSection = (typeof DIAGNOSTIC_SECTIONS)[number];
export const DIAGNOSTIC_TTL_MILLISECONDS = 5 * 60_000;
export const DIAGNOSTIC_MAX_BYTES = 256 * 1024;
export interface DiagnosticBundle {
  format: "autoheal-diagnostics";
  version: 1;
  generatedAt: number;
  evidence: {
    incident: {
      detectedAt: number | null;
      updatedAt: number | null;
      trigger: string | null;
      status: string | null;
      action: string | null;
    };
    trace?: { kind: string; at: number | null }[];
    facts?: {
      host: "host-1";
      container: "container-1";
      capturedReport: boolean;
      capturedNeighbours: number;
      protectedContainer: boolean;
      state: string | null;
      imageFingerprint: string;
    };
    usage?: Record<string, number | null>[];
  };
  manifest: {
    sections: DiagnosticSection[];
    sha256: string;
    checksumEncoding: "UTF-8 JSON.stringify(evidence)";
    redaction: string[];
    truncatedTrace: boolean;
    truncatedUsage: boolean;
  };
}
export interface DiagnosticPreview {
  id: string;
  incidentId: string;
  expiresAt: number;
  byteLength: number;
  bundle: DiagnosticBundle;
}

export const DIAGNOSTIC_ROUTES = {
  diagnosticsPreview: "/api/incidents/:incidentId/diagnostics/preview",
  diagnosticsDownload: "/api/incidents/:incidentId/diagnostics/:previewId/download",
} as const;
