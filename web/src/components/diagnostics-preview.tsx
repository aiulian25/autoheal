import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { apiPath } from "../../../src/shared/api.js";
import {
  DIAGNOSTIC_ROUTES,
  DIAGNOSTIC_SECTIONS,
  type DiagnosticBundle,
  type DiagnosticSection,
  type DiagnosticPreview,
} from "../../../src/shared/diagnostics.js";
import { api } from "../api-client.js";
import { ErrorNotice } from "./common.js";

const LABELS: Record<DiagnosticSection, string> = {
  trace: "Trace event types and timestamps",
  facts: "Anonymized host/container facts",
  usage: "Captured numeric usage",
};
export function DiagnosticsPreview({ incidentId }: { incidentId: string }) {
  const id = useId();
  const [sections, setSections] = useState<DiagnosticSection[]>([...DIAGNOSTIC_SECTIONS]);
  const preview = useMutation({
    mutationFn: () =>
      api<DiagnosticPreview>("POST", apiPath(DIAGNOSTIC_ROUTES.diagnosticsPreview, { incidentId }), { sections }),
  });
  const reset = preview.reset;
  const download = useMutation({
    mutationFn: async () => {
      if (!preview.data) return;
      const bundle = await api<DiagnosticBundle>(
        "POST",
        apiPath(DIAGNOSTIC_ROUTES.diagnosticsDownload, { incidentId, previewId: preview.data.id }),
      );
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2) + "\n"], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `autoheal-diagnostics-${preview.data.id}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    },
  });
  const resetDownload = download.reset;
  useEffect(() => {
    reset();
    resetDownload();
  }, [incidentId, reset, resetDownload]);
  const busy = preview.isPending || download.isPending;
  return (
    <details className="card diagnostics-preview">
      <summary>Download diagnostics</summary>
      <p className="small muted">
        Uses captured evidence only. Raw logs, model text, environment values, terminal output, names and addresses are
        excluded. Review the complete contents before sharing. No new runner collection occurs.
      </p>
      <fieldset disabled={busy}>
        <legend>Include in the bundle</legend>
        {DIAGNOSTIC_SECTIONS.map((section) => (
          <label className="choice-option" key={section} htmlFor={`${id}-${section}`}>
            <input
              id={`${id}-${section}`}
              type="checkbox"
              checked={sections.includes(section)}
              onChange={(event) => {
                setSections((current) =>
                  event.target.checked ? [...current, section] : current.filter((item) => item !== section),
                );
                reset();
                resetDownload();
              }}
            />
            {LABELS[section]}
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        disabled={busy || sections.length === 0}
        onClick={() => {
          resetDownload();
          preview.mutate();
        }}
      >
        Preview diagnostics
      </button>
      {preview.data && (
        <section aria-label="Diagnostic bundle preview">
          <p>
            {preview.data.byteLength.toLocaleString()} bytes · preview expires{" "}
            <time dateTime={new Date(preview.data.expiresAt).toISOString()}>
              {new Date(preview.data.expiresAt).toLocaleTimeString()}
            </time>
          </p>
          <ul>
            {preview.data.bundle.manifest.redaction.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="small mono">Evidence SHA-256: {preview.data.bundle.manifest.sha256}</p>
          <pre className="log">{JSON.stringify(preview.data.bundle, null, 2)}</pre>
          <button type="button" disabled={busy || download.isSuccess} onClick={() => download.mutate()}>
            Download reviewed bundle
          </button>
        </section>
      )}
      <ErrorNotice error={preview.error ?? download.error} />
      {download.isSuccess && <p role="status">Diagnostics downloaded. Create a new preview to download again.</p>}
    </details>
  );
}
