import { GlobalSearch } from "./global-search.js";
import { notificationHealth } from "./notification-health.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, useLayoutEffect } from "react";
import { Link, Outlet, matchPath, useLocation, useNavigate } from "react-router";
import { API_ERRORS, API_ROUTES, type OverviewView, type SessionView } from "../../../src/shared/api.js";
import { BRAND_ASSETS, HTTP_STATUS, INTEGRATION_KIND, NOTIFICATION_KINDS } from "../../../src/shared/constants.js";
import type { JarvisView } from "../../../src/shared/jarvis.js";
import { ApiError, ReadableError, api, rememberCsrfToken } from "../api-client.js";
import { PATHS, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import {
  boardQuery,
  integrationsQuery,
  jarvisQuery,
  networkOverviewQuery,
  ollamaQuery,
  overviewQuery,
  routerSettingsQuery,
} from "../queries.js";
import { NewVersionNotice } from "./new-version-notice.js";
import { ScrollToTop } from "./scroll-to-top.js";
import { Icon, type IconName } from "./icons.js";
import { useLiveUpdates } from "../live.js";
import { forgetPrivateData, isAdmin } from "../session.js";
import { ErrorNotice, Loading } from "./common.js";

interface Section {
  path: string;
  label: string;
  icon: IconName;
  // The other pages that belong to it: a host's page is in Fleet, the audit log in Activity.
  pages: readonly string[];
}

const SECTIONS: readonly Section[] = [
  {
    path: PATHS.home,
    label: TEXT.nav.attention,
    icon: "inbox",
    pages: [PATHS.board, PATHS.tasks, PATHS.task, PATHS.incident, PATHS.homeAssistant],
  },
  { path: PATHS.hosts, label: TEXT.nav.fleet, icon: "server", pages: [PATHS.host, PATHS.containers] },
  { path: PATHS.incidents, label: TEXT.nav.activity, icon: "clock", pages: [PATHS.audit, PATHS.prompt] },
  {
    path: PATHS.runbooks,
    label: TEXT.nav.rules,
    icon: "shieldCheck",
    pages: [PATHS.runbook, PATHS.replays, PATHS.replay],
  },
  {
    path: PATHS.settings,
    label: TEXT.nav.settings,
    icon: "sliders",
    pages: [PATHS.account, PATHS.users, PATHS.backups],
  },
];

// Shown only with a router set up: until then it would lead nowhere.
const NETWORK_SECTION: Section = { path: PATHS.network, label: TEXT.nav.network, icon: "server", pages: [] };
const MENU_ORDER: readonly string[] = [
  PATHS.home,
  PATHS.hosts,
  PATHS.network,
  PATHS.incidents,
  PATHS.runbooks,
  PATHS.settings,
];
const inMenuOrder = (one: Section, other: Section) => MENU_ORDER.indexOf(one.path) - MENU_ORDER.indexOf(other.path);

const isIn = (section: Section, pathname: string) =>
  [section.path, ...section.pages].some((path) => matchPath(path, pathname) !== null);

type Connection = { key: string; text: string; tone: "good" | "danger" | "off"; detail?: string };

const JARVIS_HEARD_MILLISECONDS = 5 * 60 * 1000;

// It asks after Autoheal every minute, so long silence means it is not there, however connected it reads.
function jarvisConnection(view: JarvisView, now: number): Connection {
  const key = "jarvis";
  if (view.paused) return { key, text: TEXT.nav.jarvis.paused, tone: "off" };
  const heard = view.lastHeardAt !== null && now - view.lastHeardAt < JARVIS_HEARD_MILLISECONDS;
  return heard
    ? { key, text: TEXT.nav.jarvis.connected, tone: "good" }
    : { key, text: TEXT.nav.jarvis.notHeard, tone: "danger" };
}

/** Everything connected to Autoheal, on every page, each with how it is doing. */
function Connections({ admin }: { admin: boolean }) {
  const ollama = useQuery(ollamaQuery);
  const integrations = useQuery(integrationsQuery);
  const overview = useQuery(overviewQuery);
  const jarvis = useQuery({ ...jarvisQuery, enabled: admin });
  const router = useQuery({ ...routerSettingsQuery, enabled: admin });
  const network = useQuery({ ...networkOverviewQuery, enabled: admin && router.data?.configured === true });
  const configured = (kind: string) =>
    integrations.data?.some((view) => view.kind === kind && view.source !== null) ?? false;
  const connections: Connection[] = [];
  if (ollama.data !== undefined) {
    const answering = ollama.data.reachable;
    connections.push({ key: "ollama", text: TEXT.nav.ollama(answering), tone: answering ? "good" : "danger" });
  }
  for (const kind of NOTIFICATION_KINDS.filter(configured)) {
    const health = notificationHealth(integrations.data?.find((view) => view.kind === kind)?.delivery);
    connections.push({
      key: kind,
      text: `${TEXT.services.names[kind]}: ${health.text}`,
      tone: health.tone,
      detail: health.detail,
    });
  }
  if (integrations.data !== undefined) {
    connections.push(homeAssistantConnection(configured(INTEGRATION_KIND.homeAssistant), overview.data));
  }
  if (jarvis.data?.connected) connections.push(jarvisConnection(jarvis.data, Date.now()));
  if (network.data !== undefined) {
    const connected = network.data.connected;
    connections.push({
      key: "router",
      text: connected ? TEXT.nav.router.connected : TEXT.nav.router.notAnswering,
      tone: connected ? "good" : "danger",
    });
  }
  return (
    <ul className="connections" aria-label={TEXT.nav.connections}>
      {connections.map((connection) => (
        <li key={connection.key}>
          <span className={connection.tone === "off" ? "status-dot off" : `status-dot tone-${connection.tone}`} />
          <span title={connection.detail}>{connection.text}</span>
        </li>
      ))}
    </ul>
  );
}

function homeAssistantConnection(configured: boolean, overview: OverviewView | undefined): Connection {
  const key = INTEGRATION_KIND.homeAssistant;
  if (!configured) {
    return { key, text: TEXT.nav.homeAssistant.off, tone: "off" };
  }
  return overview?.homeAssistant?.connected
    ? { key, text: TEXT.nav.homeAssistant.connected, tone: "good" }
    : { key, text: TEXT.nav.homeAssistant.notAnswering, tone: "danger" };
}

export function Layout({ session }: { session: SessionView }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useLiveUpdates();
  const board = useQuery(boardQuery);
  const router = useQuery({ ...routerSettingsQuery, enabled: isAdmin(session) });
  const routerSet = router.data?.configured === true;
  // The menu counts what should not wait: what needs you on the board.
  const waiting = board.data?.needsYou.length ?? 0;
  // Once the session has ended, by a confirmed sign-out, a timeout or a restore, private data goes with this page, in
  // the commit that removes it. Removed while the page is still mounted, an update already queued for it renders it
  // again and asks for that data anew.
  useLayoutEffect(
    () => () => {
      if (queryClient.getQueryData(SESSION_QUERY_KEY) == null) forgetPrivateData(queryClient);
    },
    [queryClient],
  );
  const signOut = useMutation({
    mutationFn: async () => {
      try {
        await api("POST", API_ROUTES.logout);
      } catch (error) {
        // Only the API's explicit absent-session response confirms that there is nothing left to revoke.
        if (!(
          error instanceof ApiError &&
          error.status === HTTP_STATUS.unauthorized &&
          error.code === API_ERRORS.notSignedIn
        ))
          throw error;
      }
    },
    onSuccess: async () => {
      await queryClient.cancelQueries();
      rememberCsrfToken(null);
      queryClient.setQueryData(SESSION_QUERY_KEY, null);
      void navigate(PATHS.login);
    },
  });
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link className="brand" to={PATHS.home}>
          <img className="brand-mark" src={BRAND_ASSETS.mark} alt="" />
          {TEXT.appName}
        </Link>
        <GlobalSearch currentHostId={matchPath(PATHS.host, pathname)?.params.hostId} />
        <nav className="nav" aria-label={TEXT.nav.label}>
          {[...SECTIONS, ...(routerSet ? [NETWORK_SECTION] : [])].toSorted(inMenuOrder).map((section) => {
            const current = isIn(section, pathname);
            return (
              <Link
                key={section.path}
                to={section.path}
                className={current ? "active" : undefined}
                aria-current={current ? "page" : undefined}
              >
                <Icon name={section.icon} />
                {section.label}
                {section.path === PATHS.home && waiting > 0 && <span className="count">{waiting}</span>}
              </Link>
            );
          })}
        </nav>
        <Connections admin={isAdmin(session)} />
        <div className="account">
          <Link to={PATHS.account}>{session.user.username}</Link>
          <button type="button" className="link" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
            {TEXT.signOut}
          </button>
        </div>
        <ErrorNotice error={signOut.isError ? new ReadableError(TEXT.signOutFailed) : null} />
      </aside>
      <main className="main">
        <NewVersionNotice />
        {/* A page not opened before loads here, while the menu stays. */}
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </main>
      <ScrollToTop />
    </div>
  );
}
