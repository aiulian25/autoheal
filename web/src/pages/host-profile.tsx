import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import { sizeText } from "../../../src/shared/constants.js";
import type { HostProfile, HostProfileAnswer } from "../../../src/shared/protocol.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading } from "../components/common.js";
import { TEXT } from "../constants.js";

const text = TEXT.hostProfile;

function Line({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="profile-line">
      <dt>{label}</dt>
      <dd>{value}</dd>
      <dd className="muted">{note}</dd>
    </div>
  );
}

const habitLine = (label: string, habit: HostProfile["user"]) =>
  habit === null ? (
    <Line label={label} value={text.nothing} />
  ) : (
    <Line label={label} value={habit.value} note={text.habitNote(habit.uses, habit.of)} />
  );

function Profile({ profile }: { profile: HostProfile }) {
  const { composeFolder, databases } = profile;
  const hasDatabases = databases.ownToAnApp + databases.standingAlone > 0;
  return (
    <>
      <p className="small muted">
        {text.explanation} {text.from(profile.containers)}
      </p>
      <dl className="profile-lines">
        {habitLine(text.user, profile.user)}
        {habitLine(text.timeZone, profile.timeZone)}
        {habitLine(text.restart, profile.restartPolicy)}
        <Line
          label={text.folder}
          value={composeFolder === null ? text.nothing : <span className="mono">{composeFolder.path}</span>}
          note={composeFolder === null ? undefined : text.folderNote(composeFolder.projects, composeFolder.of)}
        />
        {profile.mountsBesideCompose > 0 && (
          <Line label={text.places} value={text.beside} note={text.besideNote(profile.mountsBesideCompose)} />
        )}
        {profile.places.map((place) => (
          <Line
            key={place.path}
            label={text.places}
            value={<span className="mono">{place.path}</span>}
            note={text.placeNote(place.mounts, place.availableBytes === null ? null : sizeText(place.availableBytes))}
          />
        ))}
        {profile.networks.map((network) => (
          <Line
            key={network.name}
            label={text.networks}
            value={network.name}
            note={text.networkNote(network.containers)}
          />
        ))}
        {profile.proxies.map((proxy) => (
          <Line
            key={proxy.container}
            label={text.proxy}
            value={proxy.kind}
            note={text.proxyNote(proxy.container, proxy.network)}
          />
        ))}
        <Line
          label={text.database}
          value={databases.common ?? text.nothing}
          note={hasDatabases ? text.databaseNote(databases.ownToAnApp, databases.standingAlone) : undefined}
        />
      </dl>
    </>
  );
}

/** What Autoheal has worked out about a host, under its system information: asked of its runner only while open. */
export function HostProfileFold({ hostId }: { hostId: string }) {
  const [open, setOpen] = useState(false);
  const profile = useQuery({
    queryKey: ["host-profile", hostId],
    queryFn: () => api<HostProfileAnswer>("GET", apiPath(API_ROUTES.hostProfile, { hostId })),
    enabled: open,
  });
  return (
    <details className="card fold" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{text.title}</summary>
      {open && (
        <div className="stack small">
          {profile.isPending && <Loading />}
          {profile.data?.error != null && <p className="muted">{profile.data.error}</p>}
          {profile.data?.profile != null && <Profile profile={profile.data.profile} />}
          <ErrorNotice error={profile.error} />
        </div>
      )}
    </details>
  );
}
