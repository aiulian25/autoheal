import { useQuery } from "@tanstack/react-query";
import { NEW_VERSION_CHECK_MILLISECONDS, TEXT } from "../constants.js";

const SCRIPT = 'script[type="module"][src]';
const PAGE_ROOT = "/";

const scriptOf = (page: ParentNode) => page.querySelector(SCRIPT)?.getAttribute("src") ?? null;

async function servedScript() {
  const response = await fetch(PAGE_ROOT, { cache: "no-cache" });
  return scriptOf(new DOMParser().parseFromString(await response.text(), "text/html"));
}

/** A tab opened before an update keeps running the old page: each build names its script by its contents. */
export function NewVersionNotice() {
  const running = scriptOf(document);
  const served = useQuery({
    queryKey: ["served-page"],
    queryFn: servedScript,
    enabled: running !== null,
    retry: false,
    refetchInterval: NEW_VERSION_CHECK_MILLISECONDS,
    refetchOnWindowFocus: true,
  });
  const newer = served.data ?? null;
  if (running === null || newer === null || newer === running) return null;
  return (
    <p className="notice warning small new-version" role="status">
      {TEXT.newVersion.line}{" "}
      <button type="button" className="link" onClick={() => window.location.reload()}>
        {TEXT.newVersion.reload}
      </button>
    </p>
  );
}
