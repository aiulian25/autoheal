import { useEffect, useState } from "react";
import { type HostView } from "../../../../src/shared/api.js";
import {
  composeOf,
  databaseNameOf,
  envLine,
  containerNamesOf,
  isBlocking,
  withAddress,
  type InstallCheck,
  type InstallDraft,
  type InstallSpec,
} from "../../../../src/shared/install.js";
import { Loading, PlainText } from "../../components/common.js";
import { TEXT } from "../../constants.js";
import { RunnerBehind, isRunnerHost } from "../runner-behind.js";
import {
  rememberedDomain,
  withDomain,
  identityRow,
  versionName,
  folderOptions,
  lastPart,
  dataOptions,
  userOptions,
  withIds,
  proxyOf,
  countOn,
  PUBLISH,
  togglePublish,
  toggleNetwork,
  restartOptions,
  rememberDomain,
  lanAddressOf,
} from "./install-options.js";
import { ChoiceRow, Row, TextEditor, Choices } from "./choices.js";

const text = TEXT.addContainer;

function Checks({ checks }: { checks: readonly InstallCheck[] }) {
  const problems = checks.filter(isBlocking);
  return (
    <>
      {problems.map((check) => (
        <p key={check.key} className="notice warning small" role="alert">
          {check.detail}
        </p>
      ))}
      <div className="install-checks small muted">
        {checks
          .filter((check) => check.ok)
          .map((check) => (
            <span key={check.key}>
              <span className="install-tick">✓</span> {check.detail}
            </span>
          ))}
      </div>
    </>
  );
}

export function ReadyToInstall({
  host,
  draft,
  checks,
  checking,
  onChange,
  onInstall,
  installing,
  onVersion,
}: {
  onVersion: (file: string) => void;
  host: HostView;
  draft: InstallDraft;
  checks: readonly InstallCheck[];
  checking: boolean;
  onChange: (spec: InstallSpec) => void;
  onInstall: () => void;
  installing: boolean;
}) {
  const { spec } = draft;
  const [showFiles, setShowFiles] = useState(false);
  const [domain, setDomain] = useState(draft.baseUrlVariable === null ? "" : rememberedDomain());
  useEffect(() => {
    if (draft.baseUrlVariable !== null && domain !== "")
      onChange(withDomain(spec, draft.baseUrlVariable, `${spec.slug}.${domain}`));
    // Once, as it opens, from the domain this browser remembers.
  }, []);
  const blocked = checks.some(isBlocking) || checks.length === 0;
  const who = identityRow(draft);
  const reach = reachOf(spec, draft, domain, host.health?.address ?? null);
  return (
    <>
      <h2>{text.readyTitle(spec.name, host.label)}</h2>
      <div className="connect-host-body install-body">
        {isRunnerHost(host) && <RunnerBehind host={host} warning={text.runnerBehind} />}
        <div className="install-rows">
          {(draft.project?.files?.length ?? 0) > 1 && (
            <ChoiceRow
              label={text.version}
              value={draft.project!.file ?? ""}
              options={draft.project!.files!.map((file) => ({ value: file, label: versionName(file) }))}
              onChoose={onVersion}
            />
          )}
          {spec.document != null && (
            <Row label={text.containers} value={containerNamesOf(spec).join(TEXT.listComma)} why={text.togetherWhy} />
          )}
          <Row
            label={text.name}
            value={spec.name}
            editor={(close) => (
              <TextEditor
                label={text.name}
                initial={spec.name}
                mono={false}
                close={close}
                onSave={(name) => onChange({ ...spec, name })}
              />
            )}
          />
          <ChoiceRow
            label={text.folder}
            value={spec.folder}
            other
            mono
            options={folderOptions(draft)}
            onChoose={(folder) => onChange({ ...spec, folder })}
          />
          {spec.mounts.map((mount, index) => (
            <ChoiceRow
              key={mount.target}
              label={mount.service === undefined ? text.data : `${mount.service} ${lastPart(mount.target)}`}
              value={mount.source}
              other
              mono
              options={dataOptions(draft, mount.target)}
              onChoose={(source) =>
                onChange({
                  ...spec,
                  mounts: spec.mounts.map((each, at) => (at === index ? { ...each, source } : each)),
                })
              }
            />
          ))}
          {draft.identity.kind === "ids" ? (
            <ChoiceRow
              label={text.runsAs}
              value={spec.owner ?? ""}
              other
              mono
              options={userOptions(draft)}
              onChoose={(user) => onChange(withIds(spec, user))}
            />
          ) : (
            <Row label={text.runsAs} value={who.value} why={who.why} warn={who.warn} />
          )}
          <span className="install-label">
            {text.network}
            <span className="install-label-note">{text.pickAny}</span>
          </span>
          <span className="install-row-choices">
            <Choices
              several
              label={text.network}
              options={[
                ...draft.networks.map((name) => ({
                  value: name,
                  label: proxyOf(draft, [name]) === null ? name : text.networkWithProxy(name, proxyOf(draft, [name])!),
                  note: countOn(draft, name) === null ? undefined : text.containersOn(countOn(draft, name)!),
                })),
                ...(spec.port === null
                  ? []
                  : [
                      {
                        value: PUBLISH,
                        label: text.onLan(host.health?.address ?? null, spec.port.published ?? spec.port.target),
                      },
                    ]),
              ]}
              selected={(name) => (name === PUBLISH ? spec.port?.published != null : spec.networks.includes(name))}
              onChoose={(name) => onChange(name === PUBLISH ? togglePublish(spec) : toggleNetwork(spec, name))}
            />
            {spec.port?.published != null && (
              <input
                className="install-port"
                type="number"
                min={1}
                max={65535}
                aria-label={text.hostPort}
                value={spec.port.published}
                onChange={(event) =>
                  onChange({ ...spec, port: { ...spec.port!, published: Number(event.target.value) } })
                }
              />
            )}
          </span>
          <ChoiceRow
            label={text.restart}
            value={spec.restartPolicy}
            options={restartOptions(draft)}
            onChoose={(policy) => onChange({ ...spec, restartPolicy: policy as InstallSpec["restartPolicy"] })}
          />
          {spec.database !== null && (
            <Row
              label={text.database}
              value={text.ownDatabase(databaseNameOf(spec), spec.database.image)}
              why={text.ownDatabaseWhy}
            />
          )}
          {spec.port !== null && (
            <Row
              label={text.reach}
              value={<span className="mono">{reach}</span>}
              why={proxyOf(draft, spec.networks) === null ? undefined : text.yourProxy(proxyOf(draft, spec.networks)!)}
              {...(draft.baseUrlVariable === null
                ? {}
                : {
                    editor: (close: () => void) => (
                      <TextEditor
                        label={text.domain}
                        initial={domain}
                        close={close}
                        onSave={(typed) => {
                          setDomain(typed);
                          rememberDomain(typed);
                          onChange(
                            withDomain(spec, draft.baseUrlVariable!, typed === "" ? "" : `${spec.slug}.${typed}`),
                          );
                        }}
                      />
                    ),
                  })}
            />
          )}
          {draft.project?.settings.map((name) => {
            const entry = spec.environment.find((candidate) => candidate.name === name);
            return (
              <Row
                key={name}
                label={text.setting}
                value={<span className="mono">{`${name}=${entry?.value ?? ""}`}</span>}
                why={text.fromReadme}
                editor={(close) => (
                  <TextEditor
                    label={name}
                    initial={entry?.value ?? ""}
                    close={close}
                    onSave={(value) =>
                      onChange({
                        ...spec,
                        environment: spec.environment.map((each) => (each.name === name ? { ...each, value } : each)),
                      })
                    }
                  />
                )}
              />
            );
          })}
          {spec.secrets.length > 0 && (
            <Row label={text.secrets} value={text.secretsMade(spec.secrets.length)} why={text.secretsWhy} />
          )}
        </div>
        {draft.project !== null && (
          <p className="small muted">
            {text.readFrom}{" "}
            <a href={draft.project.address} target="_blank" rel="noopener noreferrer">
              {draft.project.address}
            </a>
            {text.checkIt}
          </p>
        )}
        {(draft.project?.kept?.length ?? 0) > 0 && (
          <p className="small muted">{text.keptPasswords(draft.project!.kept!.join(TEXT.listComma))}</p>
        )}
        {(draft.project?.leftOut.length ?? 0) > 0 && (
          <p className="notice warning small" role="status">
            {text.leftOut(draft.project!.leftOut.join(", "))}
          </p>
        )}
        {checking ? <Loading /> : <Checks checks={checks} />}
        {showFiles && <Files spec={withAddress(spec, draft.baseUrlVariable, host.health?.address ?? null)} />}
      </div>
      <div className="connect-host-foot">
        <button type="button" className="link" onClick={() => setShowFiles(!showFiles)}>
          {showFiles ? text.hideFiles : text.showFiles}
        </button>
        <button type="button" className="primary" disabled={blocked || checking || installing} onClick={onInstall}>
          {text.install}
        </button>
      </div>
    </>
  );
}

// Every way it can be reached, as what is selected says: its name through a proxy, and its address on the LAN.
function reachOf(spec: InstallSpec, draft: InstallDraft, domain: string, address: string | null) {
  if (spec.port === null) return "";
  const named = domain !== "" && draft.baseUrlVariable !== null ? `${spec.slug}.${domain}` : null;
  const throughProxy = spec.networks.length > 0 ? (named ?? `${spec.name}:${spec.port.target}`) : null;
  const ways = [throughProxy, lanAddressOf(spec, address)].filter((way) => way !== null);
  return ways.length === 0 ? text.notReachable : ways.join(TEXT.separator);
}

function Files({ spec }: { spec: InstallSpec }) {
  const env = [
    ...spec.environment.map(envLine),
    ...spec.secrets.map((secret) => `${secret.name}=${text.madeOnHost}`),
  ].join("\n");
  return (
    <div className="install-files">
      <div>
        <h3 className="small">{`${spec.folder}/docker-compose.yml`}</h3>
        <PlainText text={composeOf(spec)} />
      </div>
      <div>
        <h3 className="small">{`${spec.folder}/.env`}</h3>
        <PlainText text={env} />
        <p className="small muted">{text.filesNote}</p>
      </div>
    </div>
  );
}
