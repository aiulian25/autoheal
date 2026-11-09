import { RELEASE_LINK, RELEASE_PAGES, VERSION_NUMBERS } from "./constants.js";

const PATH_SEPARATOR = "/";

const urlOf = (text: string): URL | null => {
  try {
    return new URL(text);
  } catch {
    return null;
  }
};

// The project's path on its host: its owner and repository, or a GitLab project however deep its groups go.
function projectOf(url: URL, parts: number | null): string | null {
  const [path = ""] = url.pathname.split(RELEASE_LINK.projectEnd);
  const segments = path.split(PATH_SEPARATOR).filter((segment) => segment !== "");
  const project = parts === null ? segments : segments.slice(0, parts);
  if (project.length < RELEASE_LINK.fewestParts) {
    return null;
  }
  return project.join(PATH_SEPARATOR).replace(RELEASE_LINK.gitSuffix, "");
}

/**
 * Where to read what a version changed: its project's release notes, on a host whose release pages are known, found
 * by the version's numbers, so a "v" before them or a variant after misses nothing; with no numbers, all its
 * releases. Null for a source on any other host, and for none. The link is built from the host and the project's
 * path alone, on https: nothing else the label said goes into it.
 */
export function releaseNotesLink(source: string | null, version: string | null): string | null {
  const url = source === null ? null : urlOf(source);
  if (url === null) {
    return null;
  }
  const page = RELEASE_PAGES.get(url.hostname);
  if (page === undefined) {
    return null;
  }
  const project = projectOf(url, page.projectParts);
  if (project === null) {
    return null;
  }
  const numbers = version === null ? undefined : VERSION_NUMBERS.exec(version)?.[0];
  const base = `${RELEASE_LINK.scheme}${url.hostname}${PATH_SEPARATOR}${project}`;
  return numbers === undefined ? `${base}${page.all}` : `${base}${page.find}${encodeURIComponent(numbers)}`;
}
