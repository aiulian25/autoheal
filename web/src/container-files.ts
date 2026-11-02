import { API_ROUTES, apiPath } from "../../src/shared/api.js";
import { FILE_KIND, type FileOperation } from "../../src/shared/constants.js";
import type { FileAnswer, FileEntry } from "../../src/shared/protocol.js";
import { ReadableError, api } from "./api-client.js";

export interface FileBody {
  operation: FileOperation;
  path: string;
  to?: string;
  content?: string;
}

// The browser builds a string a character at a time: past this many at once, the call stack would not hold.
const CHARACTERS_AT_ONCE = 0x8000;
const ROOT = "/";

/** Asks a container's runner, through the control plane; its refusal comes back as one. */
export async function askFiles(hostId: string, containerName: string, body: FileBody): Promise<FileAnswer> {
  const answer = await api<FileAnswer>("POST", apiPath(API_ROUTES.containerFiles, { hostId, containerName }), body);
  if (answer.error !== null) {
    throw new ReadableError(answer.error);
  }
  return answer;
}

export const parentOf = (path: string) => path.slice(0, path.lastIndexOf(ROOT)) || ROOT;
export const childOf = (folder: string, name: string) => (folder === ROOT ? `${ROOT}${name}` : `${folder}/${name}`);
export const nameOf = (path: string) => path.slice(path.lastIndexOf(ROOT) + 1);

/** Each folder on the way to a path, from the root: its name and where it is. */
export function crumbsOf(path: string): { name: string; path: string }[] {
  const names = path.split(ROOT).filter(Boolean);
  return names.map((name, index) => ({ name, path: `${ROOT}${names.slice(0, index + 1).join(ROOT)}` }));
}

// Folders first, then the rest, each by name as people read them.
export const byKindThenName = (first: FileEntry, second: FileEntry) =>
  Number(second.kind === FILE_KIND.folder) - Number(first.kind === FILE_KIND.folder) ||
  first.name.localeCompare(second.name, undefined, { numeric: true });

export const bytesFromBase64 = (base64: string) =>
  Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += CHARACTERS_AT_ONCE) {
    binary += String.fromCharCode(...bytes.subarray(start, start + CHARACTERS_AT_ONCE));
  }
  return btoa(binary);
}

/** A file's text when it is UTF-8 text, null when it is something else: those are downloaded, not edited. */
export function textOf(base64: string): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytesFromBase64(base64));
  } catch {
    return null;
  }
}

export const base64FromText = (text: string) => base64FromBytes(new TextEncoder().encode(text));

/** Hands the person a file to save, from what the runner read. */
export function download(name: string, base64: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([bytesFromBase64(base64)]));
  link.download = name;
  link.click();
  // Let go of the bytes once the browser has started saving them.
  setTimeout(() => URL.revokeObjectURL(link.href));
}
