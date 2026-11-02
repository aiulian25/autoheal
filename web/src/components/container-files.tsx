import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ChangeEvent } from "react";
import { FILE_CONTENT_LIMIT_BYTES, FILE_KIND, FILE_OPERATION } from "../../../src/shared/constants.js";
import type { FileEntry } from "../../../src/shared/protocol.js";
import { ReadableError } from "../api-client.js";
import {
  askFiles,
  base64FromBytes,
  base64FromText,
  byKindThenName,
  childOf,
  crumbsOf,
  download,
  nameOf,
  parentOf,
  textOf,
  type FileBody,
} from "../container-files.js";
import { TEXT } from "../constants.js";
import { bytes } from "../format.js";
import { ErrorNotice, Loading } from "./common.js";
import { Icon } from "./icons.js";

const ROOT = "/";
const UNUSABLE_NAMES = new Set(["", ".", ".."]);
const isUsableName = (name: string) => !UNUSABLE_NAMES.has(name) && !name.includes(ROOT);

/** A file opened from the list: its text to change and save, or, when it is not text, a download. */
function FileEditor({
  path,
  ask,
  onClose,
}: {
  path: string;
  ask: (body: FileBody) => Promise<{ content: string | null }>;
  onClose: () => void;
}) {
  const text = TEXT.files;
  const read = useQuery({
    queryKey: ["container-file", path],
    queryFn: () => ask({ operation: FILE_OPERATION.read, path }),
    gcTime: 0,
    retry: false,
  });
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (content: string) => ask({ operation: FILE_OPERATION.write, path, content }),
  });
  if (read.data === undefined) {
    return read.error ? <ErrorNotice error={read.error} /> : <Loading />;
  }
  const content = read.data.content ?? "";
  const original = textOf(content);
  const shown = draft ?? original;
  return (
    <section className="file-editor stack" aria-label={path}>
      <header className="terminal-head">
        <strong className="mono">{path}</strong>
        {save.isSuccess && draft === null && <span className="muted small">{text.saved}</span>}
        <button
          type="button"
          className="icon-button"
          title={text.download(nameOf(path))}
          aria-label={text.download(nameOf(path))}
          onClick={() => download(nameOf(path), content)}
        >
          <Icon name="download" />
        </button>
        <button type="button" className="icon-button" title={text.close} aria-label={text.close} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      {shown === null ? (
        <p className="muted">{text.notText}</p>
      ) : (
        <>
          <textarea
            className="mono file-text"
            value={shown}
            spellCheck={false}
            aria-label={path}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={draft === null || save.isPending}
              onClick={() => save.mutate(base64FromText(draft!), { onSuccess: () => setDraft(null) })}
            >
              {text.save}
            </button>
          </div>
        </>
      )}
      <ErrorNotice error={save.error} />
    </section>
  );
}

function EntryName({ entry, onOpen }: { entry: FileEntry; onOpen: () => void }) {
  const text = TEXT.files;
  const icon = entry.kind === FILE_KIND.folder ? "folder" : "file";
  return (
    <>
      <button type="button" className="link file-name" onClick={onOpen}>
        <Icon name={icon} />
        {entry.name}
      </button>
      {entry.linkTarget !== null && <span className="muted small"> {text.link(entry.linkTarget)}</span>}
    </>
  );
}

/**
 * A container's files, under its row: its folders to walk through, each file to read, change, download, rename
 * or remove, new folders and uploads. Everything goes through the container's runner, which checks first.
 */
export function ContainerFiles({
  hostId,
  containerName,
  onClose,
}: {
  hostId: string;
  containerName: string;
  onClose: () => void;
}) {
  const text = TEXT.files;
  const queryClient = useQueryClient();
  const [folder, setFolder] = useState(ROOT);
  const [opened, setOpened] = useState<string | null>(null);
  // What went wrong outside the list's own reading: a name not usable, a download refused, a file too big.
  const [failure, setFailure] = useState<unknown>(null);
  const ask = (body: FileBody) => askFiles(hostId, containerName, body);
  const listingKey = ["container-files", hostId, containerName, folder];
  const listing = useQuery({
    queryKey: listingKey,
    queryFn: () => ask({ operation: FILE_OPERATION.list, path: folder }),
    gcTime: 0,
    retry: false,
  });
  const change = useMutation({
    mutationFn: ask,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: listingKey }),
  });
  const entries = [...(listing.data?.entries ?? [])].sort(byKindThenName);
  const go = (path: string) => {
    setFolder(path);
    setOpened(null);
    setFailure(null);
  };
  // A link is listed as what it leads to: a folder to walk into, or a file to open.
  const open = (entry: FileEntry) => {
    const path = childOf(folder, entry.name);
    if (entry.kind === FILE_KIND.folder) {
      go(path);
      return;
    }
    setOpened(path);
  };
  const named = (question: string, start = "") => {
    const name = window.prompt(question, start)?.trim() ?? null;
    if (name === null) {
      return null;
    }
    if (!isUsableName(name)) {
      setFailure(new ReadableError(text.badName));
      return null;
    }
    setFailure(null);
    return name;
  };
  const makeFolder = () => {
    const name = named(text.askFolderName);
    if (name !== null) {
      change.mutate({ operation: FILE_OPERATION.makeFolder, path: childOf(folder, name) });
    }
  };
  // A file open in the editor closes when it moves or goes.
  const changeEntry = (body: FileBody) => {
    if (opened === body.path) {
      setOpened(null);
    }
    change.mutate(body);
  };
  const rename = (entry: FileEntry) => {
    const name = named(text.askNewName(entry.name), entry.name);
    if (name !== null && name !== entry.name) {
      changeEntry({ operation: FILE_OPERATION.rename, path: childOf(folder, entry.name), to: childOf(folder, name) });
    }
  };
  const remove = (entry: FileEntry) => {
    const path = childOf(folder, entry.name);
    if (window.confirm(text.confirmRemove(path))) {
      changeEntry({ operation: FILE_OPERATION.remove, path });
    }
  };
  const downloadEntry = async (entry: FileEntry) => {
    const path = childOf(folder, entry.name);
    const read = await ask({ operation: FILE_OPERATION.read, path }).catch((error: unknown) => {
      setFailure(error);
      return null;
    });
    if (read?.content != null) {
      download(entry.name, read.content);
    }
  };
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) {
      return;
    }
    if (file.size > FILE_CONTENT_LIMIT_BYTES) {
      setFailure(new ReadableError(text.tooBig));
      return;
    }
    const replaces = entries.some((entry) => entry.name === file.name);
    if (replaces && !window.confirm(text.confirmReplace(file.name))) {
      return;
    }
    const content = base64FromBytes(new Uint8Array(await file.arrayBuffer()));
    change.mutate({ operation: FILE_OPERATION.write, path: childOf(folder, file.name), content });
  };
  return (
    <section className="files-panel stack" aria-label={text.title(containerName)}>
      <header className="terminal-head">
        <strong>{text.title(containerName)}</strong>
        <nav className="file-path mono" aria-label={text.title(containerName)}>
          <button type="button" className="link" onClick={() => go(ROOT)}>
            {text.root}
          </button>
          {crumbsOf(folder).map((crumb) => (
            <span key={crumb.path}>
              <button type="button" className="link" onClick={() => go(crumb.path)}>
                {crumb.name}
              </button>
              {ROOT}
            </span>
          ))}
        </nav>
        <button type="button" className="icon-button" title={text.close} aria-label={text.close} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      <div className="row files-toolbar">
        <button type="button" disabled={folder === ROOT} onClick={() => go(parentOf(folder))}>
          {text.up}
        </button>
        <button type="button" onClick={makeFolder} disabled={change.isPending}>
          {text.newFolder}
        </button>
        <label className="button">
          {text.upload}
          <input type="file" hidden onChange={(event) => void upload(event)} disabled={change.isPending} />
        </label>
        <button type="button" onClick={() => void listing.refetch()}>
          {text.refresh}
        </button>
      </div>
      <ErrorNotice error={failure} />
      <ErrorNotice error={change.error} />
      {opened !== null && <FileEditor key={opened} path={opened} ask={ask} onClose={() => setOpened(null)} />}
      {listing.data === undefined && (listing.error ? <ErrorNotice error={listing.error} /> : <Loading />)}
      {listing.data?.truncated === true && <p className="muted small">{text.truncated}</p>}
      {listing.data !== undefined && (
        <div className="table-wrap">
          <table className="files-table">
            <thead>
              <tr>
                <th>{text.name}</th>
                <th>{text.size}</th>
                <th>{text.modified}</th>
                <th>{text.mode}</th>
                <th>{text.owner}</th>
                <th>{text.actions}</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    {text.empty}
                  </td>
                </tr>
              )}
              {entries.map((entry) => (
                <tr key={entry.name}>
                  <td>
                    <EntryName entry={entry} onOpen={() => open(entry)} />
                  </td>
                  <td className="muted">{entry.kind === FILE_KIND.file ? bytes(entry.size) : ""}</td>
                  <td className="muted">{entry.modified}</td>
                  <td className="mono muted">{entry.mode}</td>
                  <td className="muted">{entry.owner}</td>
                  <td>
                    <span className="row-actions-icons">
                      {entry.kind === FILE_KIND.file && (
                        <button
                          type="button"
                          className="icon-button"
                          title={text.download(entry.name)}
                          aria-label={text.download(entry.name)}
                          onClick={() => void downloadEntry(entry)}
                        >
                          <Icon name="download" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-button"
                        title={text.rename(entry.name)}
                        aria-label={text.rename(entry.name)}
                        disabled={change.isPending}
                        onClick={() => rename(entry)}
                      >
                        <Icon name="pencil" />
                      </button>
                      <button
                        type="button"
                        className="icon-button danger"
                        title={text.remove(entry.name)}
                        aria-label={text.remove(entry.name)}
                        disabled={change.isPending}
                        onClick={() => remove(entry)}
                      >
                        <Icon name="trash" />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
