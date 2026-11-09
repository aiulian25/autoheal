import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { API_ROUTES } from "../../../src/shared/api.js";
import { SEARCH_KINDS, SEARCH_LIMITS, type SearchKind, type SearchResponse } from "../../../src/shared/search.js";
import { api } from "../api-client.js";
import { TEXT } from "../constants.js";
import { ErrorNotice, TimeAgo } from "./common.js";

const text = TEXT.globalSearch;
const LABELS: Record<SearchKind, string> = text.kinds;
export function GlobalSearch({ currentHostId }: { currentHostId?: string }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [scoped, setScoped] = useState(false);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const term = query.trim();
  const hostId = scoped ? currentHostId : undefined;
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(term), SEARCH_LIMITS.debounceMilliseconds);
    return () => window.clearTimeout(timer);
  }, [term]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('textarea, [contenteditable="true"], .xterm')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const result = useQuery({
    queryKey: ["search", debounced, hostId],
    queryFn: ({ signal }) =>
      api<SearchResponse>(
        "GET",
        API_ROUTES.search + "?" + new URLSearchParams({ q: debounced, ...(hostId ? { hostId } : {}) }),
        undefined,
        signal,
      ),
    enabled: open && debounced.length >= 2 && debounced === term,
    retry: false,
    staleTime: SEARCH_LIMITS.cacheMilliseconds,
  });
  const results = debounced === term && result.isSuccess ? result.data.results : [];
  const active = results[selected];
  const show = open && term.length >= 2;
  const close = () => {
    setOpen(false);
    setSelected(0);
  };
  return (
    <div
      className="global-search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <label className="small" htmlFor={`${id}-query`}>
        {text.label}
      </label>
      <input
        ref={input}
        id={`${id}-query`}
        type="search"
        role="combobox"
        autoComplete="off"
        maxLength={SEARCH_LIMITS.query}
        placeholder={text.placeholder}
        value={query}
        aria-expanded={show}
        aria-controls={`${id}-results`}
        aria-autocomplete="list"
        aria-activedescendant={show && active ? `${id}-result-${selected}` : undefined}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            setSelected((value) =>
              results.length ? (value + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length : 0,
            );
          }
          if (event.key === "Enter" && active) {
            event.preventDefault();
            navigate(active.href);
            close();
          }
        }}
      />
      {currentHostId && (
        <label className="small">
          <input
            type="checkbox"
            checked={scoped}
            onChange={(event) => {
              setScoped(event.target.checked);
              setSelected(0);
            }}
          />{" "}
          {text.onlyThisHost}
        </label>
      )}
      {show && (
        <div className="search-results card">
          <p className="small muted">{text.explanation}</p>
          {result.isFetching && <p role="status">{text.searching}</p>}
          <ErrorNotice error={result.error} />
          {debounced === term && result.isSuccess && results.length === 0 && <p role="status">{text.none}</p>}
          <div role="listbox" id={`${id}-results`} aria-label={text.results}>
            {SEARCH_KINDS.map(
              (kind) =>
                results.some((item) => item.kind === kind) && (
                  <div role="group" aria-label={LABELS[kind]} key={kind}>
                    <p className="small muted">{LABELS[kind]}</p>
                    {results.map((item, index) =>
                      item.kind !== kind ? null : (
                        <Link
                          role="option"
                          aria-selected={index === selected}
                          id={`${id}-result-${index}`}
                          key={`${kind}-${item.hostId}-${item.id}`}
                          to={item.href}
                          onClick={close}
                        >
                          <strong>{item.title}</strong>
                          <span className="small muted">
                            {item.snippet}
                            {TEXT.separator}
                            <TimeAgo timestamp={item.at} />
                          </span>
                        </Link>
                      ),
                    )}
                  </div>
                ),
            )}
          </div>
          {result.data?.partial && (
            <p role="status" className="small warning">
              {text.limited}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
