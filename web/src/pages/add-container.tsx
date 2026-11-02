import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { API_ROUTES, apiPath, type HostView, type JobView } from "../../../src/shared/api.js";
import { JOB_STATUS, RESTART_POLICIES } from "../../../src/shared/constants.js";
import {
  composeOf,
  databaseNameOf,
  envLine,
  containerNamesOf,
  isAddress,
  isBlocking,
  looksLikeImage,
  recipesMatching,
  withAddress,
  type InstallAnswer,
  type InstallCheck,
  type InstallDraft,
  type InstallSpec,
} from "../../../src/shared/install.js";
import { api } from "../api-client.js";
import { CopyButton, ErrorNotice, Loading, PlainText } from "../components/common.js";
import { isWaiting } from "../components/container-actions.js";
import { Progress } from "../components/install-progress.js";
import { TakeAway, useInstallJob } from "../components/take-away.js";
import { Icon } from "../components/icons.js";
import { TEXT } from "../constants.js";
import { bytes } from "../format.js";
import { DOCKER_RUN_COMMAND, dockerRunToCompose } from "../../../src/shared/docker-run.js";
import { OwnComposeEditor, type OwnStart } from "./own-compose.js";
import { RunnerBehind, isRunnerHost } from "./runner-behind.js";

const text = TEXT.addContainer;
const DOMAIN_MEMORY = "autoheal.install.domain";
const COMPOSE_BOX_LINES = 8;

function rememberedDomain() {
  try {
    return localStorage.getItem(DOMAIN_MEMORY) ?? "";
  } catch {
    return "";
  }
}

function rememberDomain(domain: string) {
  try {
    localStorage.setItem(DOMAIN_MEMORY, domain);
  } catch {
    // ponytail: only a convenience; asked again next time.
  }
}

// One line of the screen: what, its value, why, and a way to change it in place.
export function Row({
  label,
  value,
  why,
  editor,
  warn = false,
}: {
  label: string;
  value: ReactNode;
  why?: string;
  editor?: (close: () => void) => ReactNode;
  warn?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <span className="install-label">{label}</span>
      {editing && editor !== undefined ? (
        <span className="install-editor">{editor(() => setEditing(false))}</span>
      ) : (
        <>
          <span className={warn ? "install-value text-warning" : "install-value"}>{value}</span>
          <span className="install-why muted" title={why}>
            {why}
          </span>
          <span className="install-change">
            {editor !== undefined && (
              <button type="button" className="link" onClick={() => setEditing(true)}>
                {text.change}
              </button>
            )}
          </span>
        </>
      )}
    </>
  );
}

function TextEditor({
  label,
  initial,
  onSave,
  close,
  mono = true,
}: {
  label: string;
  initial: string;
  onSave: (value: string) => void;
  close: () => void;
  mono?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="install-edit"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(value.trim());
        close();
      }}
    >
      <input
        className={mono ? "mono" : undefined}
        aria-label={label}
        value={value}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit">{text.save}</button>
      <button type="button" className="quiet" onClick={close}>
        {text.cancel}
      </button>
    </form>
  );
}

// Options on the screen: a click selects one. Single choice unless \`several\`, where each click adds or takes away.
export function Choices<Value>({
  options,
  selected,
  onChoose,
  label,
}: {
  options: { value: Value; label: string; note?: string | undefined }[];
  selected: (value: Value) => boolean;
  onChoose: (value: Value) => void;
  label: string;
}) {
  return (
    <span className="install-choices" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          className="install-choice"
          aria-pressed={selected(option.value)}
          onClick={() => onChoose(option.value)}
        >
          {option.label}
          {option.note !== undefined && <span className="install-choice-note">{option.note}</span>}
        </button>
      ))}
    </span>
  );
}

// A row of options, one of them "Other" where a person may need what was not thought of.
function ChoiceRow({
  label,
  options,
  value,
  onChoose,
  other = false,
  mono = false,
}: {
  label: string;
  options: { value: string; label: string; note?: string | undefined }[];
  value: string;
  onChoose: (value: string) => void;
  other?: boolean;
  mono?: boolean;
}) {
  const offered = options.some((option) => option.value === value);
  const [typing, setTyping] = useState(false);
  return (
    <>
      <span className="install-label">{label}</span>
      <span className="install-row-choices">
        <Choices
          label={label}
          options={offered ? options : [...options, { value, label: value }]}
          selected={(candidate) => !typing && candidate === value}
          onChoose={(chosen) => {
            setTyping(false);
            onChoose(chosen);
          }}
        />
        {other && !typing && (
          <button type="button" className="install-choice" onClick={() => setTyping(true)}>
            {text.other}
          </button>
        )}
        {typing && (
          <TextEditor
            label={label}
            initial=""
            mono={mono}
            close={() => setTyping(false)}
            onSave={(typed) => {
              if (typed !== "") onChoose(typed);
            }}
          />
        )}
      </span>
    </>
  );
}

const PUBLISH = "publish a port";

const lastPart = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;
// "docker/compose/docker-compose.postgres.yml" is its "postgres" version.
const versionName = (file: string) =>
  lastPart(file)
    .replace(/\.ya?ml$/i, "")
    .replace(/^(docker-)?compose\.?/i, "") || lastPart(file);

// The proxy the chosen networks lead to, and how many are on a network, as each click changes them.
const proxyOf = (draft: InstallDraft, networks: readonly string[]) =>
  draft.proxies?.find((proxy) => networks.includes(proxy.network))?.kind ?? null;

const countOn = (draft: InstallDraft, network: string) => draft.networkCounts?.[network] ?? null;

function toggleNetwork(spec: InstallSpec, name: string): InstallSpec {
  const on = spec.networks.includes(name);
  return { ...spec, networks: on ? spec.networks.filter((each) => each !== name) : [...spec.networks, name] };
}

function togglePublish(spec: InstallSpec): InstallSpec {
  if (spec.port === null) return spec;
  return { ...spec, port: { ...spec.port, published: spec.port.published === null ? spec.port.target : null } };
}

const freeNote = (available: number | null) => (available === null ? undefined : text.free(bytes(available)));

function folderOptions(draft: InstallDraft) {
  const { slug } = draft.spec;
  const usual =
    draft.composeFolder === null
      ? []
      : [
          {
            value: `${draft.composeFolder}/${slug}`,
            label: `${draft.composeFolder}/${slug}`,
            note: draft.habits.folderProjects === null ? undefined : text.appsThere(draft.habits.folderProjects),
          },
        ];
  const disks = draft.places
    .filter((place) => place.path !== draft.composeFolder)
    .map((place) => ({
      value: `${place.path}/${slug}`,
      label: `${place.path}/${slug}`,
      note: freeNote(place.availableBytes),
    }));
  return [...usual, ...disks];
}

function dataOptions(draft: InstallDraft, target: string) {
  const { slug, mounts } = draft.spec;
  const folderName = target.split("/").filter(Boolean).at(-1) ?? "data";
  const original = mounts.find((mount) => mount.target === target)?.source;
  const beside = original?.startsWith("./") ? original : `./${folderName}`;
  return [
    { value: beside, label: text.withTheApp },
    ...draft.places.map((place) => ({
      value: `${place.path}/${slug}/${folderName}`,
      label: `${place.path}/${slug}/${folderName}`,
      note: freeNote(place.availableBytes),
    })),
  ];
}

function userOptions(draft: InstallDraft) {
  const usual =
    draft.userHabit ?? (draft.identity.kind === "ids" ? { value: draft.identity.user, uses: 0, of: 0 } : null);
  return usual === null
    ? []
    : [{ value: usual.value, label: usual.value, note: usual.uses > 0 ? text.likeOthers(usual.uses) : undefined }];
}

function restartOptions(draft: InstallDraft) {
  const habit = draft.restartHabit;
  return RESTART_POLICIES.map((policy) => ({
    value: policy,
    label: text.restarts[policy],
    note: habit?.value === policy ? text.likeOthers(habit.uses) : undefined,
  }));
}

function identityRow({ identity }: InstallDraft) {
  if (identity.kind === "ids") {
    return {
      value: identity.user,
      why: identity.uses === null ? text.idsUsual : text.likeOthers(identity.uses),
      warn: false,
    };
  }
  if (identity.kind === "image") return { value: text.imageUser(identity.user), why: text.imageChoice, warn: false };
  return { value: text.root, why: text.imageChoice, warn: true };
}

const withIds = (spec: InstallSpec, user: string): InstallSpec => {
  const [id = "", group = ""] = user.split(":");
  return {
    ...spec,
    owner: user,
    environment: spec.environment.map((entry) => {
      if (entry.name === "PUID") return { ...entry, value: id };
      return entry.name === "PGID" ? { ...entry, value: group } : entry;
    }),
  };
};

function withDomain(spec: InstallSpec, variable: string, domain: string): InstallSpec {
  const others = spec.environment.filter((entry) => entry.name !== variable);
  return {
    ...spec,
    environment: domain === "" ? others : [...others, { name: variable, value: `https://${domain}` }],
  };
}

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

function ReadyToInstall({
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
          <span className="install-label">{text.network}</span>
          <span className="install-row-choices">
            <Choices
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

function lanAddressOf(spec: InstallSpec, address: string | null) {
  if (spec.port?.published == null) return null;
  return address === null ? text.onPort(spec.port.published) : `${address}:${spec.port.published}`;
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

function Installing({
  host,
  draft,
  started,
  onClose,
}: {
  host: HostView;
  draft: InstallDraft;
  started: JobView;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const job = useInstallJob(host.id, started)!;
  const { spec } = draft;
  const waiting = isWaiting(job);
  useEffect(() => {
    if (!waiting) void queryClient.invalidateQueries();
  }, [waiting]);
  if (waiting) {
    return (
      <>
        <h2>{text.installingTitle(spec.name, host.label)}</h2>
        <div className="connect-host-body install-body">
          <Progress job={job} />
          <p className="small muted">{text.canClose}</p>
        </div>
        <div className="connect-host-foot">
          <button type="button" onClick={onClose}>
            {text.close}
          </button>
        </div>
      </>
    );
  }
  const succeeded = job.status === JOB_STATUS.succeeded;
  const address = host.health?.address ?? null;
  const lanAddress = address === null ? null : lanAddressOf(spec, address);
  const proxyEntry = spec.networks.length > 0 && spec.port !== null ? `${spec.name}:${spec.port.target}` : null;
  return (
    <>
      <h2>{text.readyTitle(spec.name, host.label)}</h2>
      <div className="connect-host-body install-body">
        <p className={succeeded ? "install-done" : "install-failed"} role="status">
          {succeeded ? text.running(spec.name) : text.failed(spec.name)}
        </p>
        {!succeeded && job.outcome !== null && <p className="small">{job.outcome}</p>}
        {!succeeded && job.output !== null && <PlainText text={job.output} />}
        {succeeded && proxyEntry !== null && (
          <p className="row small">
            <span className="muted">{text.inProxy(proxyOf(draft, spec.networks))}</span>{" "}
            <span className="mono">{proxyEntry}</span>
            <CopyButton text={proxyEntry} />
          </p>
        )}
        {succeeded && lanAddress !== null && (
          <p className="row small">
            <span className="muted">{text.onTheLan}</span> <span className="mono">{lanAddress}</span>
            <CopyButton text={lanAddress} />
          </p>
        )}
        {succeeded && spec.secrets.length > 0 && (
          <p className="small muted">{text.secretsWhere(`${spec.folder}/.env`)}</p>
        )}
        {!succeeded && <p className="small muted">{text.nothingElse(host.label, spec.folder)}</p>}
      </div>
      <div className="connect-host-foot">
        <TakeAway hostId={host.id} name={spec.name} folder={spec.folder} onDone={onClose} />
        <button type="button" className={succeeded && lanAddress !== null ? undefined : "primary"} onClick={onClose}>
          {text.close}
        </button>
        {succeeded && lanAddress !== null && (
          <a className="button primary" href={`http://${lanAddress}`} target="_blank" rel="noopener noreferrer">
            {text.open(spec.name)}
          </a>
        )}
      </div>
    </>
  );
}

function FindApp({
  host,
  onDraft,
  onOwn,
}: {
  host: HostView;
  onDraft: (answer: InstallAnswer) => void;
  onOwn: (start: OwnStart) => void;
}) {
  const [typed, setTyped] = useState("");
  const ask = useMutation({
    mutationFn: (wanted: { image?: string; recipe?: string; project?: string; compose?: string }) =>
      api<InstallAnswer>("POST", apiPath(API_ROUTES.hostInstallDraft, { hostId: host.id }), wanted),
    onSuccess: (answer) => {
      if (answer.draft !== null) onDraft(answer);
    },
  });
  const recipes = recipesMatching(typed);
  const trimmed = typed.trim();
  const pastedCompose = /^\s*services\s*:/m.test(typed) ? typed : null;
  const pastedRun = pastedCompose === null && DOCKER_RUN_COMMAND.test(typed) ? typed : null;
  const converted = pastedRun === null ? null : dockerRunToCompose(pastedRun);
  const pastedOther = pastedCompose !== null || pastedRun !== null;
  const address = !pastedOther && isAddress(trimmed) ? trimmed : null;
  const image = !pastedOther && address === null && looksLikeImage(typed) ? trimmed : null;
  return (
    <>
      <h2>{text.title(host.label)}</h2>
      <div className="connect-host-body install-body">
        {isRunnerHost(host) && <RunnerBehind host={host} warning={text.runnerBehind} />}
        <textarea
          className={pastedOther ? "install-search mono" : "install-search"}
          aria-label={text.searchLabel}
          placeholder={text.search}
          rows={pastedOther ? COMPOSE_BOX_LINES : 1}
          value={typed}
          autoFocus
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value)}
        />
        {trimmed === "" && (
          <button
            type="button"
            className="install-result"
            onClick={() => onOwn({ compose: "", env: "", leftOut: [], converted: false })}
          >
            <strong>{text.writeOwn}</strong>
            <span className="muted small">{text.writeOwnWhy}</span>
          </button>
        )}
        {converted !== null && !("problem" in converted) && (
          <button type="button" className="install-result" onClick={() => onOwn({ ...converted, converted: true })}>
            <strong>{text.convertRun}</strong>
            <span className="muted small">{text.convertRunWhy}</span>
          </button>
        )}
        {converted !== null && "problem" in converted && (
          <p className="notice warning small" role="alert">
            {converted.problem}
          </p>
        )}
        {recipes.map((recipe) => (
          <button
            key={recipe.id}
            type="button"
            className="install-result"
            disabled={ask.isPending}
            onClick={() => ask.mutate({ recipe: recipe.id })}
          >
            <strong>{recipe.name}</strong>
            <span className="muted small">{recipe.about}</span>
          </button>
        ))}
        {image !== null && (
          <button
            type="button"
            className="install-result"
            disabled={ask.isPending}
            onClick={() => ask.mutate({ image })}
          >
            <strong className="mono">{image}</strong>
            <span className="muted small">{text.readImage}</span>
          </button>
        )}
        {address !== null && (
          <button
            type="button"
            className="install-result"
            disabled={ask.isPending}
            onClick={() => ask.mutate({ project: address })}
          >
            <strong className="mono">{address}</strong>
            <span className="muted small">{text.readProject}</span>
          </button>
        )}
        {pastedCompose !== null && (
          <button
            type="button"
            className="install-result install-result-first"
            onClick={() => onOwn({ compose: pastedCompose, env: "", leftOut: [], converted: false })}
          >
            <strong>{text.useAsIs}</strong>
            <span className="muted small">{text.useAsIsWhy}</span>
          </button>
        )}
        {pastedCompose !== null && (
          <button
            type="button"
            className="install-result"
            disabled={ask.isPending}
            onClick={() => ask.mutate({ compose: pastedCompose })}
          >
            <strong>{text.useCompose}</strong>
            <span className="muted small">{text.useComposeWhy}</span>
          </button>
        )}
        {trimmed !== "" && recipes.length === 0 && image === null && address === null && !pastedOther && (
          <p className="small muted">{text.noMatch}</p>
        )}
        {ask.isPending && <Loading />}
        {ask.data?.error != null && (
          <p className="notice warning small" role="alert">
            {ask.data.error}
          </p>
        )}
        <ErrorNotice error={ask.error} />
      </div>
    </>
  );
}

/** Puts a new app on a host: one box, then one screen with everything already filled in. */
export function AddContainer({ host }: { host: HostView }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<InstallDraft | null>(null);
  const [checks, setChecks] = useState<InstallCheck[]>([]);
  const [job, setJob] = useState<JobView | null>(null);
  const [own, setOwn] = useState<OwnStart | null>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const close = () => {
    setOpen(false);
    setDraft(null);
    setChecks([]);
    setJob(null);
    setOwn(null);
  };
  const guided = useMutation({
    mutationFn: (compose: string) =>
      api<InstallAnswer>("POST", apiPath(API_ROUTES.hostInstallDraft, { hostId: host.id }), { compose }),
    onSuccess: (answer) => {
      if (answer.draft === null) return;
      setOwn(null);
      setDraft(answer.draft);
      setChecks(answer.checks);
    },
  });
  const check = useMutation({
    mutationFn: (spec: InstallSpec) =>
      api<InstallAnswer>("POST", apiPath(API_ROUTES.hostInstallCheck, { hostId: host.id }), { spec }),
    onSuccess: (answer) => setChecks(answer.checks),
  });
  const install = useMutation({
    mutationFn: (spec: InstallSpec) =>
      api<JobView>("POST", apiPath(API_ROUTES.hostInstall, { hostId: host.id }), { spec }),
    onSuccess: setJob,
  });
  const version = useMutation({
    mutationFn: (composeFile: string) =>
      api<InstallAnswer>("POST", apiPath(API_ROUTES.hostInstallDraft, { hostId: host.id }), {
        project: draft?.project?.address,
        composeFile,
      }),
    onSuccess: (answer) => {
      if (answer.draft !== null) {
        setDraft(answer.draft);
        setChecks(answer.checks);
      }
    },
  });
  const changed = (spec: InstallSpec) => {
    if (draft === null) return;
    setDraft({ ...draft, spec });
    check.mutate(spec);
  };
  return (
    <>
      <button type="button" className="add-container" onClick={() => setOpen(true)}>
        <Icon name="plus" />
        {text.add}
      </button>
      <dialog ref={dialog} className="connect-host add-container-dialog" onClose={close}>
        {open && own !== null && (
          <OwnComposeEditor
            host={host}
            start={own}
            onGuided={(compose) => guided.mutate(compose)}
            guidedBusy={guided.isPending}
            guidedRefusal={guided.data?.error ?? null}
            onClose={close}
          />
        )}
        {open && own === null && job === null && draft === null && (
          <FindApp
            host={host}
            onDraft={(answer) => {
              setDraft(answer.draft);
              setChecks(answer.checks);
            }}
            onOwn={setOwn}
          />
        )}
        {open && job === null && draft !== null && (
          <ReadyToInstall
            host={host}
            draft={draft}
            checks={checks}
            checking={check.isPending || version.isPending}
            onChange={changed}
            onInstall={() =>
              install.mutate(withAddress(draft.spec, draft.baseUrlVariable, host.health?.address ?? null))
            }
            onVersion={(file) => version.mutate(file)}
            installing={install.isPending}
          />
        )}
        {open && job !== null && draft !== null && (
          <Installing host={host} draft={draft} started={job} onClose={close} />
        )}
        <div className="install-errors">
          <ErrorNotice error={check.error ?? install.error ?? version.error ?? guided.error} />
          {version.data?.error != null && <p className="notice warning small">{version.data.error}</p>}
        </div>
        <button
          type="button"
          className="icon-button dialog-close"
          title={text.close}
          aria-label={text.close}
          onClick={close}
        >
          <Icon name="x" />
        </button>
      </dialog>
    </>
  );
}
