import { shellQuoted } from "./install-script.js";

export const PREVIOUS_SUFFIX = ".autoheal-previous";
export const JOURNAL_SEEN_LINE = "journal";
export const EXIT_ROLLED_BACK = 71;
export const EXIT_BLOCKED = 72;
export const EXIT_NOT_INSIDE = 73;
const JOURNAL_NAME = ".autoheal-transaction";
const SIDECAR_INFIX = ".autoheal.";
const TEMPORARY_SUFFIX = "XXXXXX";
const EXISTED = "E";
const CREATED = "N";
const SIDECAR_SUFFIX = /^[A-Za-z0-9]+$/;

export type StackFileWrite = { path: string } & ({ text: string } | { copyOf: string });

export interface StackCommit {
  folder: string;
  writes: readonly StackFileWrite[];
  // What can be put back afterwards is this save and no older one; putting back itself leaves them all kept.
  forgetPrevious: readonly string[];
  keepPrevious: boolean;
}

export interface JournalEntry {
  path: string;
  newSuffix: string;
  // Null for a file this save was creating.
  oldSuffix: string | null;
}

export const journalPath = (folder: string) => `${folder}/${JOURNAL_NAME}`;
const previousOf = (path: string) => shellQuoted(`${path}${PREVIOUS_SUFFIX}`);
const sidecarPattern = (path: string) => shellQuoted(`${path}${SIDECAR_INFIX}${TEMPORARY_SUFFIX}`);
const sidecar = (path: string, suffix: string) => shellQuoted(`${path}${SIDECAR_INFIX}${suffix}`);
const encodedPath = (path: string) => shellQuoted(Buffer.from(path).toString("base64"));

// A file whose new version is still beside it was never replaced, and may be one that cannot be: left alone.
const undone = (newFile: string, putBack: string) =>
  `if [ ! -e ${newFile} ]; then ${putBack}; fi && rm -f -- ${newFile}`;
const putBackOld = (path: string, oldFile: string) =>
  `if [ -f ${oldFile} ]; then mv -f ${oldFile} ${shellQuoted(path)}; fi`;

function stageLines(write: StackFileWrite, index: number): string[] {
  const quoted = shellQuoted(write.path);
  const newFile = `"$new${index}"`;
  const oldFile = `"$old${index}"`;
  const contents =
    "text" in write
      ? `printf %s ${shellQuoted(Buffer.from(write.text).toString("base64"))} | base64 -d > ${newFile}`
      : `cp -p ${shellQuoted(write.copyOf)} ${newFile}`;
  return [
    `new${index}=$(mktemp ${sidecarPattern(write.path)})`,
    `if [ -f ${quoted} ]; then old${index}=$(mktemp ${sidecarPattern(write.path)}); cp -p ${quoted} ${oldFile}; cp -p ${quoted} ${newFile}; fi`,
    contents,
  ];
}

const journalLine = ({ path }: StackFileWrite, index: number) =>
  `if [ -n "$old${index}" ]; then printf '${EXISTED} %s %s %s\\n' ${encodedPath(path)} "\${new${index}##*.}" "\${old${index}##*.}"; ` +
  `else printf '${CREATED} %s %s\\n' ${encodedPath(path)} "\${new${index}##*.}"; fi >> "$journalTemporary"`;

const rollbackOf = ({ path }: StackFileWrite, index: number) => {
  const quoted = shellQuoted(path);
  const oldFile = `"$old${index}"`;
  const putBack = `if [ -n "$old${index}" ]; then ${putBackOld(path, oldFile)}; else rm -f -- ${quoted}; fi`;
  return `{ ${undone(`"$new${index}"`, putBack)}; }`;
};

/**
 * A stack's files replaced as one, by one script. Everything is staged beside its file first, owner and mode kept, and
 * a failure there changes nothing. The journal then says what is being replaced, so whatever stops the renames, the
 * old version comes back: here when a rename fails, by `recoveryScript` when the script dies. Removing the journal is
 * the moment the new version counts, and the kept versions are already this save's by then: each made anew, so a link
 * put in its place is replaced, never written through.
 */
export function commitScript({ folder, writes, forgetPrevious, keepPrevious }: StackCommit): string {
  const journal = shellQuoted(journalPath(folder));
  const temporaries = writes.flatMap((_, index) => [`"$new${index}"`, `"$old${index}"`]);
  const keptLine = ({ path }: StackFileWrite, index: number) =>
    `rm -f -- ${previousOf(path)} && if [ -n "$old${index}" ]; then cp -p "$old${index}" ${previousOf(path)}; fi`;
  const steps = [
    ...writes.map(({ path }, index) => `mv -f "$new${index}" ${shellQuoted(path)}`),
    ...forgetPrevious.map((path) => `rm -f -- ${previousOf(path)}`),
    ...(keepPrevious ? writes.map((write, index) => `{ ${keptLine(write, index)}; }`) : []),
    "true",
  ];
  const rollback = [
    ...writes.map(rollbackOf),
    ...writes.map((_, index) => `rm -f -- "$old${index}"`),
    `rm -f -- ${journal}`,
  ];
  return [
    "set -e",
    `${writes.map((_, index) => `new${index}= old${index}=`).join(" ")} journalTemporary=`,
    `trap 'rm -f -- ${temporaries.join(" ")} "$journalTemporary"' EXIT`,
    ...writes.flatMap(stageLines),
    `journalTemporary=$(mktemp ${shellQuoted(`${journalPath(folder)}.${TEMPORARY_SUFFIX}`)})`,
    ...writes.map(journalLine),
    `mv -f "$journalTemporary" ${journal}`,
    "trap - EXIT",
    `if ! { ${steps.join(" && ")}; }; then`,
    `  if { ${rollback.join(" && ")}; }; then exit ${EXIT_ROLLED_BACK}; fi`,
    `  exit ${EXIT_BLOCKED}`,
    "fi",
    `rm -f -- ${journal}`,
    `rm -f -- ${writes.map((_, index) => `"$old${index}"`).join(" ")} || true`,
  ].join("\n");
}

export const readJournalScript = (folder: string, mark: string) => {
  const journal = shellQuoted(journalPath(folder));
  return `if [ -f ${journal} ]; then echo ${shellQuoted(mark)}; cat ${journal}; fi`;
};

/** What a journal says, or null when it names anything `isOurs` refuses: it lies in a folder others may write to. */
export function parseJournal(text: string, isOurs: (path: string) => boolean): JournalEntry[] | null {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const entries = lines.map((line): JournalEntry | null => {
    const [kind, encoded = "", newSuffix = "", oldSuffix = null] = line.trim().split(" ");
    const path = Buffer.from(encoded, "base64").toString("utf8");
    const suffixesFine = SIDECAR_SUFFIX.test(newSuffix) && (oldSuffix === null || SIDECAR_SUFFIX.test(oldSuffix));
    const kindFine = kind === EXISTED ? oldSuffix !== null : kind === CREATED && oldSuffix === null;
    return suffixesFine && kindFine && isOurs(path) ? { path, newSuffix, oldSuffix } : null;
  });
  return entries.includes(null) ? null : (entries as JournalEntry[]);
}

/**
 * The old version back after a script died part way. Run again after dying itself, it finishes the job. Each step only
 * after the last one worked, or the old copies and the journal would go though the files did not come back.
 */
export function recoveryScript(folder: string, entries: readonly JournalEntry[]): string {
  // The journal is only text: a link in the folder could point a path that reads as inside it anywhere on the host.
  // Each one inside the folder is looked at as the host resolves it, and nothing is done unless all stay inside.
  const inFolder = entries.filter(({ path }) => path.startsWith(`${folder}/`));
  const staysInside = ({ path }: JournalEntry) => {
    const parent = shellQuoted(path.slice(0, path.lastIndexOf("/")));
    return `case "$(cd -P -- ${parent} 2>/dev/null && pwd || echo "$root")/" in "$root"/*) ;; *) exit ${EXIT_NOT_INSIDE} ;; esac`;
  };
  return [
    ...(inFolder.length === 0 ? [] : [`root=$(cd -P -- ${shellQuoted(folder)} && pwd)`, ...inFolder.map(staysInside)]),
    ...entries.flatMap(({ path, newSuffix, oldSuffix }) => {
      const oldFile = oldSuffix === null ? null : sidecar(path, oldSuffix);
      const putBack = oldFile === null ? `rm -f -- ${shellQuoted(path)}` : putBackOld(path, oldFile);
      return [undone(sidecar(path, newSuffix), putBack), ...(oldFile === null ? [] : [`rm -f -- ${oldFile}`])];
    }),
    `rm -f -- ${shellQuoted(journalPath(folder))}`,
  ].join(" &&\n");
}
