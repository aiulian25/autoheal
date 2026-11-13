import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { API_ROUTES } from "../../../src/shared/api.js";
import { APP_VERSION } from "../../../src/shared/constants.js";
import {
  ASSISTANT_FILES,
  JARVIS_ADDRESS,
  JARVIS_KIND,
  JARVIS_NAME,
  JARVIS_TEST_OUTCOME,
  assistantFileLink,
  type JarvisAskingView,
  type JarvisConnected,
  type JarvisHostNames,
  type JarvisOpenQuestionView,
  type JarvisSetupLinks,
  type JarvisTestOutcome,
  type JarvisTestQuestionView,
  type JarvisView,
} from "../../../src/shared/jarvis.js";
import { api } from "../api-client.js";
import { useAskInPlace } from "../components/ask-in-place.js";
import { CopyButton, ErrorNotice, TimeAgo } from "../components/common.js";
import { JOB_REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { timeOfDay } from "../format.js";
import { jarvisQuery } from "../queries.js";

const text = TEXT.jarvis;
// The webhook ID is a password: the card shows this in its place, and Copy takes the real one.
const MASKED = "••••••••••••";
const CONTRACT_LINK = assistantFileLink(APP_VERSION, ASSISTANT_FILES.contract);

type Refresh = () => Promise<unknown>;

function SetupBlock({ setup }: { setup: string }) {
  return (
    <div className="jarvis-setup">
      <p className="small muted">{text.setupNote}</p>
      <pre className="mono compose-problem">{setup}</pre>
      <CopyButton text={setup} />
    </div>
  );
}

function HostNames({ host, onSaved }: { host: JarvisHostNames; onSaved: Refresh }) {
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (aliases: string[]) => api("PUT", API_ROUTES.jarvisAliases, { hostId: host.id, aliases }),
    onSuccess: async () => {
      setSaved(true);
      await onSaved();
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);
    const typed = String(new FormData(event.currentTarget).get("aliases") ?? "");
    save.mutate(
      typed
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    );
  };
  return (
    <form className="jarvis-name" onSubmit={submit}>
      <label className="small" htmlFor={`names-${host.id}`}>
        {host.label}
      </label>
      <input
        id={`names-${host.id}`}
        name="aliases"
        aria-label={text.namesOf(host.label)}
        defaultValue={host.aliases.join(", ")}
        key={host.aliases.join(",")}
      />
      <button type="submit" disabled={save.isPending}>
        {text.save}
      </button>
      {saved && !save.isPending && <span className="small muted">{text.saved}</span>}
      {save.isError && <span className="small text-danger">{text.nameTaken}</span>}
    </form>
  );
}

interface WordFieldProps {
  field: "name" | "address";
  label: string;
  hint: string;
  refused: string;
  route: string;
  characters: number;
  value: string | null;
  onSaved: Refresh;
}

// One of the two words a house may give it: what it is called, and how it addresses people. Empty is none.
function WordField({ field, label, hint, refused, route, characters, value, onSaved }: WordFieldProps) {
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (typed: string) => api("PUT", route, { [field]: typed }),
    onSuccess: async () => {
      setSaved(true);
      await onSaved();
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);
    save.mutate(String(new FormData(event.currentTarget).get(field) ?? ""));
  };
  const id = `jarvis-${field}`;
  return (
    <>
      <form className="jarvis-name" onSubmit={submit}>
        <label className="small" htmlFor={id}>
          {label}
        </label>
        <input id={id} name={field} maxLength={characters} defaultValue={value ?? ""} key={value ?? ""} />
        <button type="submit" disabled={save.isPending}>
          {text.save}
        </button>
        {saved && !save.isPending && <span className="small muted">{text.saved}</span>}
        {save.isError && <span className="small text-danger">{refused}</span>}
      </form>
      <p className="small muted">{hint}</p>
    </>
  );
}

// What the test question came to. Each way it can fail names the step to look at.
const UNANSWERED: Record<Exclude<JarvisTestOutcome, typeof JARVIS_TEST_OUTCOME.answered>, string> = {
  [JARVIS_TEST_OUTCOME.asking]: text.asking,
  [JARVIS_TEST_OUTCOME.notTaken]: text.notTaken,
  [JARVIS_TEST_OUTCOME.nothingBack]: text.nothingBack,
  [JARVIS_TEST_OUTCOME.putOff]: text.putOff,
  [JARVIS_TEST_OUTCOME.notAnswered]: text.notAnswered,
};

function testQuestionLine(test: JarvisTestQuestionView | null): string | null {
  if (test === null) return null;
  if (test.answer !== null) return text.answeredTest(test.answer.said, test.answer.how, test.answer.seconds);
  if (test.outcome === JARVIS_TEST_OUTCOME.answered) return null;
  return UNANSWERED[test.outcome];
}

// The test of the block, answered by its key or by the answer box.
function testLine(view: JarvisView, sent: { delivered: boolean } | null): string | null {
  if (view.lastTestMilliseconds !== null) return text.answered(view.name, view.lastTestMilliseconds);
  if (view.testing) return text.testing(view.name);
  if (sent === null) return null;
  return sent.delivered ? text.blockNotAnswered(view.name) : text.notDelivered;
}

// What an open question is about, in the card's words: a restart, a host's updates, a newer version or an update.
function aboutLine(question: JarvisOpenQuestionView): string {
  const { kind, host, names, from, to } = question;
  if (kind === JARVIS_KIND.reboot) return text.askedAboutRestart(host);
  if (kind === JARVIS_KIND.hostUpdates) return text.askedAboutHostUpdates(names.length, host);
  if (from !== null && to !== null) return text.askedAboutVersion(names[0]!, host, from, to);
  return text.askedAbout(names, host);
}

function openLine(question: JarvisOpenQuestionView): string {
  return text.asked(timeOfDay(question.askedAt), aboutLine(question), question.asks);
}

const isWaiting = (view: JarvisView | undefined) =>
  view?.testing === true || view?.testQuestion?.outcome === JARVIS_TEST_OUTCOME.asking;

interface StepsProps {
  view: JarvisView;
  links: JarvisSetupLinks;
  onConnect: () => void;
  connecting: boolean;
  onTest: () => void;
  testing: boolean;
}

/** What a house does in Home Assistant, one button a step, and nothing typed but one paste. */
function SetupSteps({ view, links, onConnect, connecting, onTest, testing }: StepsProps) {
  // The blueprint's form wants the webhook ID: opening it makes one, when there is none yet.
  const opened = () => {
    if (!view.connected) onConnect();
  };
  const result = testQuestionLine(view.testQuestion);
  const canTest = view.connected && view.homeAssistantConnected && !testing;
  return (
    <section className="jarvis-steps" aria-labelledby="jarvis-steps">
      <h4 id="jarvis-steps" className="small">
        {text.steps}
      </h4>
      <ol>
        <li>
          <span className="jarvis-step">
            <strong>{text.answerBox}</strong> <span className="small muted">{text.answerBoxHint}</span>
          </span>
          <a className="button" href={links.helpers} target="_blank" rel="noopener noreferrer">
            {text.openHelpers}
          </a>
        </li>
        <li>
          <span className="jarvis-step">
            <strong>{text.automation}</strong> <span className="small muted">{text.automationHint}</span>
          </span>
          <a className="button" href={links.blueprintImport} target="_blank" rel="noopener noreferrer" onClick={opened}>
            {text.importBlueprint}
          </a>
          {view.webhookId !== null ? (
            <span className="jarvis-webhook">
              <span className="small muted">{text.webhookId}</span> <code className="mono">{MASKED}</code>{" "}
              <CopyButton text={view.webhookId} />
            </span>
          ) : (
            <span className="jarvis-webhook small muted">
              {text.webhookIdLater}{" "}
              <button type="button" disabled={connecting} onClick={onConnect}>
                {text.showWebhookId}
              </button>
            </span>
          )}
        </li>
        <li>
          <span className="jarvis-step">
            <strong>{text.testQuestion}</strong> <span className="small muted">{text.testQuestionHint(view.name)}</span>
          </span>
          <button type="button" className="primary" disabled={!canTest} onClick={onTest}>
            {text.testQuestion}
          </button>
          {view.connected && !view.homeAssistantConnected && (
            <p className="small text-warning">{text.testNeedsHomeAssistant}</p>
          )}
          {result !== null && (
            <p className="small" role="status">
              {result}
            </p>
          )}
        </li>
      </ol>
    </section>
  );
}

// What is asked rather than told. Greyed until a test question was answered: nobody could answer before.
function AskingTicks({ asking, onSaved }: { asking: JarvisAskingView; onSaved: Refresh }) {
  const save = useMutation({
    mutationFn: (chosen: { updates: boolean; versions: boolean }) => api("PUT", API_ROUTES.jarvisAsking, chosen),
    onSuccess: onSaved,
  });
  const { ready, updates, versions } = asking;
  return (
    <fieldset className="choice-options jarvis-asking" disabled={!ready || save.isPending}>
      <legend className="small">{text.whoAnswers}</legend>
      <label className="choice-option">
        <input
          type="checkbox"
          checked={updates}
          onChange={(event) => save.mutate({ updates: event.target.checked, versions })}
        />
        <span className="choice-words">{text.askUpdates}</span>
      </label>
      <label className="choice-option">
        <input
          type="checkbox"
          checked={versions}
          onChange={(event) => save.mutate({ updates, versions: event.target.checked })}
        />
        <span className="choice-words">{text.askVersions}</span>
      </label>
      {!ready && <p className="small muted">{text.notReady}</p>}
      <ErrorNotice error={save.error} />
    </fieldset>
  );
}

interface OwnProps {
  view: JarvisView;
  secret: string | null;
  onTest: () => void;
  testing: boolean;
  sent: { delivered: boolean } | null;
}

// For a house that writes its own automations: the contract, and the block of today for one that uses its key.
function OwnAutomations({ view, secret, onTest, testing, sent }: OwnProps) {
  const [setupShown, setSetupShown] = useState(false);
  const line = testLine(view, sent);
  return (
    <details className="jarvis-own">
      <summary className="small">{text.ownAutomations}</summary>
      <p className="small">
        {text.contract}{" "}
        <a href={CONTRACT_LINK} target="_blank" rel="noopener noreferrer">
          {text.contractLink}
        </a>
      </p>
      {view.connected && (
        <>
          <p className="small muted">{text.blockNote}</p>
          {secret !== null && (
            <div className="jarvis-setup">
              <p className="small text-warning">{text.keyOnce}</p>
              <pre className="mono compose-problem">{secret}</pre>
              <CopyButton text={secret} />
            </div>
          )}
          {setupShown && view.setup !== null && <SetupBlock setup={view.setup} />}
          {line !== null && (
            <p className="small" role="status">
              {line}
            </p>
          )}
          <div className="row">
            <button type="button" disabled={testing || view.testing} onClick={onTest}>
              {text.test}
            </button>
            <button type="button" onClick={() => setSetupShown(!setupShown)}>
              {setupShown ? text.hideSetup : text.showSetup}
            </button>
          </div>
        </>
      )}
    </details>
  );
}

/** The assistant in Home Assistant: three steps to set it up, a test question that proves answers come back, and what it may ask. */
export function JarvisCard() {
  const queryClient = useQueryClient();
  const inPlace = useAskInPlace();
  const refresh = () => queryClient.invalidateQueries({ queryKey: jarvisQuery.queryKey });
  const [secret, setSecret] = useState<string | null>(null);
  const [sent, setSent] = useState<{ delivered: boolean } | null>(null);
  const jarvis = useQuery({
    ...jarvisQuery,
    refetchInterval: (query) => (isWaiting(query.state.data) ? JOB_REFRESH_MILLISECONDS : false),
  });
  const connect = useMutation({
    mutationFn: () => api<JarvisConnected>("POST", API_ROUTES.jarvisConnect),
    onSuccess: async (answer) => {
      setSecret(answer.secret);
      await refresh();
    },
  });
  const testQuestion = useMutation({
    mutationFn: () => api<{ delivered: boolean }>("POST", API_ROUTES.jarvisTestQuestion),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: () => api<{ delivered: boolean }>("POST", API_ROUTES.jarvisTest),
    onSuccess: async (answer) => {
      setSent(answer);
      await refresh();
    },
  });
  const pause = useMutation({
    mutationFn: (paused: boolean) => api("PUT", API_ROUTES.jarvisPause, { paused }),
    onSuccess: refresh,
  });
  const disconnect = useMutation({
    mutationFn: () => api("DELETE", API_ROUTES.jarvis),
    onSuccess: async () => {
      setSecret(null);
      setSent(null);
      await refresh();
    },
  });
  const heard = jarvis.data?.lastTestMilliseconds ?? null;
  useEffect(() => {
    if (heard !== null) setSecret(null);
  }, [heard]);
  const view = jarvis.data;
  if (view === undefined) return <ErrorNotice error={jarvis.error} />;
  const confirmDisconnect = () => {
    inPlace.confirm(text.disconnectConfirm(view.name), () => disconnect.mutate());
  };
  return (
    <section className={view.connected ? "card settings-card" : "card settings-card dashed"} aria-labelledby="jarvis">
      <header className="settings-card-head">
        <h3 id="jarvis">{text.title}</h3>
        <span className={view.connected ? "small" : "small muted"}>
          {view.paused && text.paused}
          {view.connected && !view.paused && text.connected}
          {!view.connected && text.notConnected}
        </span>
      </header>
      <p className="settings-card-text">{text.explanation(view.name)}</p>
      {!view.homeAssistantSet && <p className="small muted">{text.needsHomeAssistant}</p>}
      {view.homeAssistantSet && view.links !== null && (
        <SetupSteps
          view={view}
          links={view.links}
          onConnect={() => connect.mutate()}
          connecting={connect.isPending}
          onTest={() => testQuestion.mutate()}
          testing={testQuestion.isPending}
        />
      )}
      {view.connected && (
        <>
          <AskingTicks asking={view.asking} onSaved={refresh} />
          <WordField
            field="name"
            label={text.name}
            hint={text.nameHint}
            refused={text.nameRefused}
            route={API_ROUTES.jarvisName}
            characters={JARVIS_NAME.characters}
            value={view.name}
            onSaved={refresh}
          />
          <WordField
            field="address"
            label={text.address}
            hint={text.addressHint}
            refused={text.addressRefused}
            route={API_ROUTES.jarvisAddress}
            characters={JARVIS_ADDRESS.characters}
            value={view.address}
            onSaved={refresh}
          />
          <p className="small muted">
            {view.lastHeardAt === null ? (
              text.never
            ) : (
              <>
                {text.lastHeard} <TimeAgo timestamp={view.lastHeardAt} />
                {view.heardByAnswerBox && text.byAnswerBox}
              </>
            )}
          </p>
          {view.waiting > 0 && <p className="small muted">{text.waiting(view.waiting)}</p>}
          {view.notConfirmed > 0 && (
            <p className="small text-warning">{text.notConfirmed(view.name, view.notConfirmed)}</p>
          )}
          {view.linesDropped > 0 && <p className="small text-warning">{text.linesDropped(view.linesDropped)}</p>}
          <p className="small">
            <span className="muted">{text.summaryNow(view.name)}:</span> {view.summary}
          </p>
          <details className="jarvis-names">
            <summary className="small">{text.names}</summary>
            <p className="small muted">{text.namesHint(view.name)}</p>
            {view.hosts.map((host) => (
              <HostNames key={host.id} host={host} onSaved={refresh} />
            ))}
          </details>
          {(view.open.length > 0 || view.recent.length > 0) && (
            <div className="jarvis-recent">
              <h4 className="small">{text.recent}</h4>
              <ul className="plain-list small">
                {view.open.map((question) => (
                  <li key={question.id}>{openLine(question)}</li>
                ))}
                {view.recent.map((item) => (
                  <li key={item.id} className={item.tier === "urgent" ? "text-danger" : undefined}>
                    {item.text}{" "}
                    <span className="muted">
                      <TimeAgo timestamp={item.sentAt} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {view.homeAssistantSet && (
        <OwnAutomations view={view} secret={secret} onTest={() => test.mutate()} testing={test.isPending} sent={sent} />
      )}
      {view.connected && (
        <div className="row">
          <button type="button" onClick={() => pause.mutate(!view.paused)}>
            {view.paused ? text.resume : text.pause}
          </button>
          <button type="button" className="danger" onClick={confirmDisconnect}>
            {text.disconnect}
          </button>
        </div>
      )}
      {inPlace.question}
      <ErrorNotice error={connect.error ?? testQuestion.error ?? test.error ?? pause.error ?? disconnect.error} />
    </section>
  );
}
