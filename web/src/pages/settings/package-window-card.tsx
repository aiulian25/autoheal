import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_ROUTES, type HostUpdateSettingsView } from "../../../../src/shared/api.js";
import { api } from "../../api-client.js";
import { ErrorNotice, Loading } from "../../components/common.js";
import { TEXT } from "../../constants.js";
import { hostUpdatesQuery } from "../../queries.js";
import { refreshSettingsNotice } from "./refresh-settings-notice.js";

const text = TEXT.settingsPage;

// --- Schedules ---------------------------------------------------------------------------------------

const WINDOW_FIELDS = { start: "windowStart", end: "windowEnd", security: "securityInWindow" } as const;

/** Each host's nightly window, and whether security fixes go in on their own: saved as soon as changed. */
export function PackageWindowCard({ admin }: { admin: boolean }) {
  const queryClient = useQueryClient();
  const settings = useQuery(hostUpdatesQuery);
  const save = useMutation({
    // One save after another, each on top of what the last one kept: a quick move from From to To keeps both.
    scope: { id: API_ROUTES.hostUpdateSettings },
    mutationFn: (changed: Partial<HostUpdateSettingsView>) => {
      const kept = queryClient.getQueryData<HostUpdateSettingsView>(hostUpdatesQuery.queryKey);
      return api<HostUpdateSettingsView>("PUT", API_ROUTES.hostUpdateSettings, { ...kept, ...changed });
    },
    onSuccess: (view) => {
      queryClient.setQueryData(hostUpdatesQuery.queryKey, view);
      void queryClient.invalidateQueries({ queryKey: ["host-packages"] });
      void refreshSettingsNotice(queryClient);
    },
  });
  const current = settings.data;
  return (
    <section className="card settings-card" aria-labelledby="window-title">
      <h3 id="window-title">{text.window.title}</h3>
      <p className="settings-card-text small">{text.window.explanation}</p>
      {current === undefined && <Loading />}
      {current !== undefined && (
        <>
          <div className="window-times">
            <label>
              {text.window.from}
              <input
                type="time"
                name={WINDOW_FIELDS.start}
                defaultValue={current.windowStart}
                disabled={!admin}
                required
                onBlur={(event) =>
                  event.target.value !== current.windowStart && save.mutate({ windowStart: event.target.value })
                }
              />
            </label>
            <label>
              {text.window.to}
              <input
                type="time"
                name={WINDOW_FIELDS.end}
                defaultValue={current.windowEnd}
                disabled={!admin}
                required
                onBlur={(event) =>
                  event.target.value !== current.windowEnd && save.mutate({ windowEnd: event.target.value })
                }
              />
            </label>
          </div>
          <label className="choice-option security-fixes">
            <input
              type="checkbox"
              name={WINDOW_FIELDS.security}
              defaultChecked={current.securityInWindow}
              disabled={!admin}
              onChange={(event) => save.mutate({ securityInWindow: event.target.checked })}
            />
            <span className="choice-words">{text.window.securityFixes}</span>
          </label>
        </>
      )}
      {save.isSuccess && <span className="small saved-note">{TEXT.hostControl.saved}</span>}
      <ErrorNotice error={save.error ?? settings.error} />
    </section>
  );
}
