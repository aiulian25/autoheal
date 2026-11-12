import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { Navigate, Outlet, createBrowserRouter, type RouteObject } from "react-router";
import { ErrorNotice, Loading } from "./components/common.js";
import { Layout } from "./components/layout.js";
import { RouteError } from "./components/route-error.js";
import { PATHS } from "./constants.js";
import { NotFoundPage } from "./pages/not-found-page.js";
import { isAdmin, oneTimeHandoff, requiredStep, useSession, useSignedInSession } from "./session.js";

// Each page's code arrives the first time it is opened, not with the dashboard itself.
const pageFrom = <Name extends string>(load: () => Promise<Record<Name, ComponentType>>, name: Name) =>
  lazy(async () => ({ default: (await load())[name] }));

const LoginPage = pageFrom(() => import("./pages/auth-pages.js"), "LoginPage");
const SecondFactorPage = pageFrom(() => import("./pages/auth-pages.js"), "SecondFactorPage");
const ChangePasswordPage = pageFrom(() => import("./pages/auth-pages.js"), "ChangePasswordPage");
const TotpSetupPage = pageFrom(() => import("./pages/auth-pages.js"), "TotpSetupPage");
const AttentionPage = pageFrom(() => import("./pages/attention-page.js"), "AttentionPage");
const BoardPage = pageFrom(() => import("./pages/board-page.js"), "BoardPage");
const TasksPage = pageFrom(() => import("./pages/tasks-page.js"), "TasksPage");
const IncidentsPage = pageFrom(() => import("./pages/operations-pages.js"), "IncidentsPage");
const IncidentDetailPage = pageFrom(() => import("./pages/incident-page.js"), "IncidentDetailPage");
const FleetPage = pageFrom(() => import("./pages/fleet-page.js"), "FleetPage");
const HostPage = pageFrom(() => import("./pages/host-page.js"), "HostPage");
const ContainersPage = pageFrom(() => import("./pages/inventory-pages.js"), "ContainersPage");
const HomeAssistantPage = pageFrom(() => import("./pages/home-assistant-page.js"), "HomeAssistantPage");
const NetworkPage = pageFrom(() => import("./pages/network-page.js"), "NetworkPage");
const RunbooksPage = pageFrom(() => import("./pages/runbooks-page.js"), "RunbooksPage");
const RunbookDetailPage = pageFrom(() => import("./pages/runbooks-page.js"), "RunbookDetailPage");
const ReplaysPage = pageFrom(() => import("./pages/replays-page.js"), "ReplaysPage");
const ReplayDetailPage = pageFrom(() => import("./pages/replays-page.js"), "ReplayDetailPage");
const UsersPage = pageFrom(() => import("./pages/users-page.js"), "UsersPage");
const BackupsPage = pageFrom(() => import("./pages/backups-page.js"), "BackupsPage");
const AuditLogPage = pageFrom(() => import("./pages/audit-page.js"), "AuditLogPage");
const AccountPage = pageFrom(() => import("./pages/account-page.js"), "AccountPage");
const SettingsPage = pageFrom(() => import("./pages/settings-page.js"), "SettingsPage");
const PromptPage = pageFrom(() => import("./pages/prompt-page.js"), "PromptPage");

function SessionBoundary() {
  const session = useSession();
  if (session.isPending) {
    return <Loading />;
  }
  if (session.error) {
    return <ErrorNotice error={session.error} />;
  }
  return (
    <Suspense fallback={<Loading />}>
      <Outlet />
    </Suspense>
  );
}

/** One of the sign-in steps: shown only when it is the step this session needs next. */
function Step({ path, children }: { path: string; children: ReactNode }) {
  const session = useSession().data ?? null;
  const next = requiredStep(session);
  // What is shown only once stays until the person says they saved it, for as long as they are signed in.
  const holding = path === PATHS.totpSetup && session !== null && oneTimeHandoff.open;
  const shown = next === path || holding;
  return shown ? children : <Navigate to={next ?? PATHS.home} replace />;
}

/** The signed-in dashboard, mounted only while the session needs no other step first. */
export function SignedInApp() {
  const session = useSession().data ?? null;
  const next = requiredStep(session);
  return next === null ? <Layout session={session!} /> : <Navigate to={next} replace />;
}

function AdminOnly({ children }: { children: ReactNode }) {
  return isAdmin(useSignedInSession()) ? children : <NotFoundPage />;
}

export const routes: RouteObject[] = [
  {
    element: <SessionBoundary />,
    errorElement: (
      <main className="centered">
        <RouteError />
      </main>
    ),
    children: [
      {
        path: PATHS.login,
        element: (
          <Step path={PATHS.login}>
            <LoginPage />
          </Step>
        ),
      },
      {
        path: PATHS.secondFactor,
        element: (
          <Step path={PATHS.secondFactor}>
            <SecondFactorPage />
          </Step>
        ),
      },
      {
        path: PATHS.changePassword,
        element: (
          <Step path={PATHS.changePassword}>
            <ChangePasswordPage />
          </Step>
        ),
      },
      {
        path: PATHS.totpSetup,
        element: (
          <Step path={PATHS.totpSetup}>
            <TotpSetupPage />
          </Step>
        ),
      },
      {
        element: <SignedInApp />,
        children: [
          {
            // Pathless, under the layout: a page that fails to render is replaced, the menu and session stay.
            errorElement: <RouteError />,
            children: [
              { path: PATHS.home, element: <AttentionPage /> },
              { path: PATHS.board, element: <BoardPage /> },
              // The old Needs you list: the Attention page lists the same items now.
              { path: PATHS.approvals, element: <Navigate to={PATHS.home} replace /> },
              { path: PATHS.tasks, element: <TasksPage /> },
              { path: PATHS.task, element: <TasksPage /> },
              { path: PATHS.incidents, element: <IncidentsPage /> },
              { path: PATHS.incident, element: <IncidentDetailPage /> },
              { path: PATHS.hosts, element: <FleetPage /> },
              { path: PATHS.host, element: <HostPage /> },
              { path: PATHS.containers, element: <ContainersPage /> },
              { path: PATHS.homeAssistant, element: <HomeAssistantPage /> },
              { path: PATHS.network, element: <NetworkPage /> },
              { path: PATHS.runbooks, element: <RunbooksPage /> },
              { path: PATHS.runbook, element: <RunbookDetailPage /> },
              { path: PATHS.replays, element: <ReplaysPage /> },
              { path: PATHS.replay, element: <ReplayDetailPage /> },
              {
                path: PATHS.users,
                element: (
                  <AdminOnly>
                    <UsersPage />
                  </AdminOnly>
                ),
              },
              {
                path: PATHS.backups,
                element: (
                  <AdminOnly>
                    <BackupsPage />
                  </AdminOnly>
                ),
              },
              {
                path: PATHS.audit,
                element: (
                  <AdminOnly>
                    <AuditLogPage />
                  </AdminOnly>
                ),
              },
              { path: PATHS.account, element: <AccountPage /> },
              { path: PATHS.settings, element: <SettingsPage /> },
              { path: PATHS.prompt, element: <PromptPage /> },
              { path: "*", element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
