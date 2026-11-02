import { useState } from "react";
import { NavigationType, useLocation, useNavigationType, useSearchParams } from "react-router";
import { QUERY_TRUE, SEARCH_PARAMETERS, TEXT } from "../constants.js";

/**
 * Filters start from the address, so a link can open a filtered list, and the address follows
 * every change. The inputs read local state, which updates at once: the address updates a moment
 * later, and an input bound to it would drop keystrokes. The filters' own changes replace the
 * address; a link followed here or a step back sets them again.
 */
export function useFilters() {
  const [parameters, setParameters] = useSearchParams();
  const location = useLocation();
  const navigationType = useNavigationType();
  const fromAddress = () =>
    Object.fromEntries(Object.values(SEARCH_PARAMETERS).map((name) => [name, parameters.get(name) ?? ""]));
  const [values, setValues] = useState<Record<string, string>>(fromAddress);
  const [seenLocation, setSeenLocation] = useState(location.key);
  const arrivedElsewhere = seenLocation !== location.key && navigationType !== NavigationType.Replace;
  if (seenLocation !== location.key) {
    setSeenLocation(location.key);
  }
  if (arrivedElsewhere) {
    setValues(fromAddress());
  }
  const set = (name: string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    setParameters(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === "") {
          next.delete(name);
          return next;
        }
        next.set(name, value);
        return next;
      },
      { replace: true },
    );
  };
  // Several at once: one change of the address, as separate ones would overwrite each other.
  const setAll = (changes: Record<string, string>) => {
    setValues((current) => ({ ...current, ...changes }));
    setParameters(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [name, value] of Object.entries(changes)) {
          if (value === "") next.delete(name);
          else next.set(name, value);
        }
        return next;
      },
      { replace: true },
    );
  };
  return {
    search: values[SEARCH_PARAMETERS.search] ?? "",
    problemsOnly: values[SEARCH_PARAMETERS.problemsOnly] === QUERY_TRUE,
    hostId: values[SEARCH_PARAMETERS.hostId] ?? "",
    set,
    setAll,
  };
}

export function ProblemsOnlyToggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="choice">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {TEXT.containers.problemsOnly}
    </label>
  );
}

/** Which container's stats are open beneath its row: in the address, so a link can open them. */
export interface Selection {
  open: string | null;
  // The one a link opened, not a click: its stats are brought into view once they show.
  arrived: string | null;
  // Opens a container's stats, or closes them when they are already open.
  toggle: (key: string) => void;
}

export function useContainerSelection(): Selection {
  const [parameters, setParameters] = useSearchParams();
  const open = parameters.get(SEARCH_PARAMETERS.container);
  const arrived = useNavigationType() === NavigationType.Replace ? null : open;
  const toggle = (key: string) =>
    setParameters(
      (current) => {
        const next = new URLSearchParams(current);
        if (open === key) {
          next.delete(SEARCH_PARAMETERS.container);
          return next;
        }
        next.set(SEARCH_PARAMETERS.container, key);
        return next;
      },
      { replace: true },
    );
  return { open, arrived, toggle };
}
