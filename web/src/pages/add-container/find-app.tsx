import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { API_ROUTES, apiPath, type HostView } from "../../../../src/shared/api.js";
import { isAddress, looksLikeImage, recipesMatching, type InstallAnswer } from "../../../../src/shared/install.js";
import { api } from "../../api-client.js";
import { ErrorNotice, Loading } from "../../components/common.js";
import { TEXT } from "../../constants.js";
import { DOCKER_RUN_COMMAND, dockerRunToCompose } from "../../../../src/shared/docker-run.js";
import { type OwnStart } from "../own-compose.js";
import { RunnerBehind, isRunnerHost } from "../runner-behind.js";

const text = TEXT.addContainer;

const COMPOSE_BOX_LINES = 8;

export function FindApp({
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
