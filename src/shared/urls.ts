import { WEB_LINK_CHARACTERS, WEB_LINK_PATTERN } from "./constants.js";

/** A link from someone else's data (a label, an attribute), kept whole or not at all: only http and https. */
export const webLinkOf = (value: unknown): string | null =>
  typeof value === "string" && value.length <= WEB_LINK_CHARACTERS && WEB_LINK_PATTERN.test(value) ? value : null;

/** Append a path to a base URL, keeping any path prefix the base already has (e.g. behind a proxy). */
export const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, "")}${path}`;
