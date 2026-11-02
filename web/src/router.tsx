import type { ReactNode } from "react";
import { Navigate, Outlet, createBrowserRouter, type RouteObject } from "react-router";
import { ErrorNotice, Loading } from "./components/common.js";
import { Layout } from "./components/layout.js";
import { RouteError } from "./components/route-error.js";
import { PATHS } from "./constants.js";
import { ChangePasswordPage, LoginPage, SecondFactorPage, TotpSetupPage } from "./pages/auth-pages.js";
import {
  AuditLogPage,
  NotFoundPage,
  PromptPage,
  ReplayDetailPage,
  ReplaysPage,
  RunbookDetailPage,
  RunbooksPage,
  UsersPage,
} from "./pages/management-pages.js";
import { ContainersPage } from "./pages/inventory-pages.js";
import { HostPage } from "./pages/host-page.js";
import { SettingsPage } from "./pages/settings-page.js";
import { FleetPage } from "./pages/fleet-page.js";
import { IncidentDetailPage } from "./pages/incident-page.js";
import { IncidentsPage } from "./pages/operations-pages.js";
import { AccountPage } from "./pages/account-page.js";
import { BackupsPage } from "./pages/backups-page.js";
import { AttentionPage } from "./pages/attention-page.js";
import { BoardPage } from "./pages/board-page.js";
import { HomeAssistantPage } from "./pages/home-assistant-page.js";
import { NetworkPage } from "./pages/network-page.js";
import { TasksPage } from "./pages/tasks-page.js";
import { isAdmin, requiredStep, useSession, useSignedInSession } from "./session.js";

function SessionBoundary() {
  const session = useSession();
  if (session.isPending) {
    return <Loading />;
  }
  if (session.error) {
    return <ErrorNotice error={session.error} />;
  }
  return <Outlet />;
}

/** One of the sign-in steps: shown only when it is the step this session needs next. */
function Step({ path, children }: { path: string; children: ReactNode }) {
  const next = requiredStep(useSession().data ?? null);
  return next === path ? children : <Navigate to={next ?? PATHS.home} replace />;
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
