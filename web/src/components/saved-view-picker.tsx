import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { API_ROUTES, apiPath, type HostView } from "../../../src/shared/api.js";
import { isSameFilter, type SavedView, type ViewPreferences } from "../../../src/shared/view-preferences.js";
import { api } from "../api-client.js";
import { QUERY_TRUE, SEARCH_PARAMETERS, TEXT } from "../constants.js";
import { viewPreferencesQuery } from "../queries.js";
import { ErrorNotice } from "./common.js";
import type { useFilters } from "./filters.js";

const text = TEXT.savedViews;

/**
 * Named filters of a person's own, beside the filters themselves. They only set the same filters a person could set by
 * hand, so the list behind them is still whatever the control plane lets them see. Nothing shows until there is
 * something to save or to choose.
 */
export function SavedViewPicker({
  filters,
  hosts,
}: {
  filters: ReturnType<typeof useFilters>;
  hosts: readonly HostView[] | undefined;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [hostGone, setHostGone] = useState(false);
  const queryClient = useQueryClient();
  const preferences = useQuery(viewPreferencesQuery);
  const views = preferences.data?.views ?? [];
  const current = { search: filters.search, problemsOnly: filters.problemsOnly, hostId: filters.hostId };
  const chosen = views.find((view) => isSameFilter(view, current));
  const stored = (next: ViewPreferences) => queryClient.setQueryData(viewPreferencesQuery.queryKey, next);
  const save = useMutation({
    mutationFn: () => api<ViewPreferences>("POST", API_ROUTES.accountSavedViews, { name, ...current }),
    onSuccess: (next) => {
      stored(next);
      setNaming(false);
      setName("");
    },
  });
  const remove = useMutation({
    mutationFn: (viewId: string) => api<ViewPreferences>("DELETE", apiPath(API_ROUTES.accountSavedView, { viewId })),
    onSuccess: stored,
  });
  // Checked each time one is opened: a host it was saved for may have gone since.
  const open = (view: SavedView) => {
    const available = view.hostId === "" || hosts?.some(({ id }) => id === view.hostId) === true;
    setHostGone(!available);
    filters.setAll({
      [SEARCH_PARAMETERS.search]: view.search,
      [SEARCH_PARAMETERS.problemsOnly]: view.problemsOnly ? QUERY_TRUE : "",
      [SEARCH_PARAMETERS.hostId]: available ? view.hostId : "",
    });
  };
  const choose = (viewId: string) => {
    const view = views.find(({ id }) => id === viewId);
    if (view !== undefined) {
      open(view);
      return;
    }
    setHostGone(false);
    filters.setAll({
      [SEARCH_PARAMETERS.search]: "",
      [SEARCH_PARAMETERS.problemsOnly]: "",
      [SEARCH_PARAMETERS.hostId]: "",
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  const filtered = current.search !== "" || current.problemsOnly || current.hostId !== "";
  return (
    <>
      {views.length > 0 && (
        <label>
          {text.label}
          <select
            value={chosen?.id ?? ""}
            disabled={hosts === undefined}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="">{text.none}</option>
            {views.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {chosen !== undefined && (
        <button type="button" className="quiet" disabled={remove.isPending} onClick={() => remove.mutate(chosen.id)}>
          {text.remove}
        </button>
      )}
      {filtered && chosen === undefined && !naming && (
        <button type="button" className="quiet" onClick={() => setNaming(true)}>
          {text.save}
        </button>
      )}
      {naming && (
        <form className="filters" onSubmit={submit}>
          <label>
            {text.name}
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <button type="submit" disabled={save.isPending}>
            {text.saveNow}
          </button>
          <button type="button" className="quiet" onClick={() => setNaming(false)}>
            {text.cancel}
          </button>
        </form>
      )}
      {hostGone && <p className="small muted">{text.hostGone}</p>}
      <ErrorNotice error={save.error ?? remove.error} />
    </>
  );
}
