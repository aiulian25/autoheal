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
import { JSON_INDENT } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { TEXT } from "../constants.js";
import { ErrorNotice } from "./common.js";

const text = TEXT.diagnostics;
const LABELS: Record<DiagnosticSection, string> = text.sections;
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
      <summary>{text.title}</summary>
      <p className="small muted">{text.explanation}</p>
      <fieldset disabled={busy}>
        <legend>{text.include}</legend>
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
        {text.preview}
      </button>
      {preview.data && (
        <section aria-label={text.previewLabel}>
          <p>
            {text.size(preview.data.byteLength.toLocaleString())}
            {TEXT.separator}
            {text.expires}{" "}
            <time dateTime={new Date(preview.data.expiresAt).toISOString()}>
              {new Date(preview.data.expiresAt).toLocaleTimeString()}
            </time>
          </p>
          <ul>
            {preview.data.bundle.manifest.redaction.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="small mono">{text.hash(preview.data.bundle.manifest.sha256)}</p>
          <pre className="log">{JSON.stringify(preview.data.bundle, null, JSON_INDENT)}</pre>
          <button type="button" disabled={busy || download.isSuccess} onClick={() => download.mutate()}>
            {text.download}
          </button>
        </section>
      )}
      <ErrorNotice error={preview.error ?? download.error} />
      {download.isSuccess && <p role="status">{text.downloaded}</p>}
    </details>
  );
}
