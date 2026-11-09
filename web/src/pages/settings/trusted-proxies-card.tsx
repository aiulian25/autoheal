import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent } from "react";
import { API_ROUTES, type SettingsView, type TrustedProxiesView } from "../../../../src/shared/api.js";
import { INTEGRATION_SOURCES } from "../../../../src/shared/constants.js";
import { api } from "../../api-client.js";
import { ErrorNotice } from "../../components/common.js";
import { TEXT } from "../../constants.js";
import { settingsQuery } from "../../queries.js";
import { refreshSettingsNotice } from "./refresh-settings-notice.js";

const text = TEXT.settingsPage;

// How the person's own request came in: straight from their browser, through a proxy Autoheal does not
// trust yet, or through one it trusts.
function arrivalLine(view: TrustedProxiesView): string {
  const proxies = text.proxies;
  if (view.forwardedFor === null) {
    return proxies.direct(view.peer);
  }
  return view.seenAs === view.peer
    ? proxies.notTrusted(view.peer, view.forwardedFor)
    : proxies.trusted(view.peer, view.seenAs);
}

// The proxy this request came through, when Autoheal does not take its word yet: the one to offer trusting.
const untrustedProxyOf = (view: TrustedProxiesView) =>
  view.forwardedFor !== null && view.seenAs === view.peer ? view.peer : null;

export function TrustedProxiesCard({ view }: { view: TrustedProxiesView }) {
  const queryClient = useQueryClient();
  const save = useMutation({
    // One change after another, each on top of the list the last one kept: two quick ones keep each other.
    scope: { id: API_ROUTES.trustedProxies },
    mutationFn: (change: (addresses: string[]) => string[]) => {
      const kept = queryClient.getQueryData<SettingsView>(settingsQuery.queryKey)?.trustedProxies.addresses ?? [];
      return api<TrustedProxiesView>("PUT", API_ROUTES.trustedProxies, { addresses: change(kept) });
    },
    onSuccess: (trustedProxies) => {
      queryClient.setQueryData<SettingsView>(
        settingsQuery.queryKey,
        (settings) => settings && { ...settings, trustedProxies },
      );
      void refreshSettingsNotice(queryClient);
    },
  });
  const proxies = text.proxies;
  const fixed = view.source === INTEGRATION_SOURCES.environment;
  const offered = fixed ? null : untrustedProxyOf(view);
  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const entry = String(new FormData(event.currentTarget).get("address") ?? "").trim();
    save.mutate((addresses) => [...addresses, entry]);
    event.currentTarget.reset();
  };
  return (
    <section className="card keys-card" aria-labelledby="proxies-title">
      <div className="keys-head">
        <h3 id="proxies-title">{proxies.title}</h3>
        <p className="small muted">{proxies.explanation}</p>
      </div>
      <div className="key-row">
        <span className="arrival small">{arrivalLine(view)}</span>
        {offered !== null && (
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate((addresses) => [...addresses, offered])}
          >
            {proxies.trust(offered)}
          </button>
        )}
      </div>
      {view.addresses.map((address) => (
        <div key={address} className="key-row">
          <span className="mono">{address}</span>
          {!fixed && (
            <button
              className="quiet danger"
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate((addresses) => addresses.filter((other) => other !== address))}
            >
              {proxies.remove}
            </button>
          )}
        </div>
      ))}
      {fixed ? (
        <p className="key-form small muted">{proxies.fromEnvironment}</p>
      ) : (
        <form className="key-form" onSubmit={add}>
          <label>
            {proxies.newAddress}
            <span className="key-form-row">
              <input name="address" required placeholder={proxies.placeholder} />
              <button type="submit" disabled={save.isPending}>
                {proxies.add}
              </button>
            </span>
          </label>
        </form>
      )}
      <ErrorNotice error={save.error} />
    </section>
  );
}
