// The reads several pages share, so each is fetched once and refreshed on one schedule.

import type { ViewPreferences } from "../../src/shared/view-preferences.js";
import type { JarvisView } from "../../src/shared/jarvis.js";
import type { RegistryCredentialView } from "../../src/shared/registry-credentials.js";
import type { AvailabilityGroupView } from "../../src/shared/availability-groups.js";
import {
  API_ROUTES,
  CONTAINER_QUERY,
  JOB_QUERY,
  TASK_FILTERS,
  TASK_QUERY,
  apiPath,
  type BackupView,
  type BoardView,
  type ContainerView,
  type HomeAssistantView,
  type HostPackagesView,
  type HostUpdateSettingsView,
  type HostView,
  type IntegrationView,
  type LocalHostView,
  type OllamaServersView,
  type OllamaSettingsView,
  type OllamaStatusView,
  type OverviewView,
  type PasskeyStatusView,
  type SelfUpdateView,
  type SettingsView,
  type JobView,
  type TaskSummaryView,
  type SshHostDetailsView,
  type SshKeyView,
} from "../../src/shared/api.js";
import { HOST_STATE, POWER_SETTLED } from "../../src/shared/constants.js";
import type { NetworkOverviewView, RouterSettingsView } from "../../src/shared/network.js";
import { api } from "./api-client.js";
import { INVENTORY_REFRESH_MILLISECONDS, POWER_REFRESH_MILLISECONDS, REFRESH_MILLISECONDS } from "./constants.js";

export const boardQuery = {
  queryKey: ["board"],
  queryFn: () => api<BoardView>("GET", API_ROUTES.board),
  refetchInterval: REFRESH_MILLISECONDS,
} as const;

// Whether passkeys work at this address, and whether the sign-in page offers one.
export const passkeyStatusQuery = {
  queryKey: ["passkey-status"],
  queryFn: () => api<PasskeyStatusView>("GET", API_ROUTES.passkeyStatus),
} as const;

export const hostsQuery = {
  queryKey: ["hosts"],
  queryFn: () => api<HostView[]>("GET", API_ROUTES.hosts),
  // Every 2 s while a host is being rebooted or shut down: the page follows it down and back as it happens.
  refetchInterval: (query: { state: { data?: HostView[] } }) =>
    (query.state.data ?? []).some((host) => host.power !== undefined && !POWER_SETTLED.includes(host.power.phase))
      ? POWER_REFRESH_MILLISECONDS
      : INVENTORY_REFRESH_MILLISECONDS,
} as const;

// Whether the runner on the dashboard's own machine was revoked: an admin can add it again in one click.
export const localHostQuery = {
  queryKey: ["hosts", "local"],
  queryFn: () => api<LocalHostView>("GET", API_ROUTES.localHost),
} as const;

// The same read, for lists: a revoked host is left out, and reached only from its old tasks and incidents.
// One person's own: it changes only when they change it, so it is not polled.
export const viewPreferencesQuery = {
  queryKey: ["view-preferences"],
  queryFn: () => api<ViewPreferences>("GET", API_ROUTES.accountViewPreferences),
} as const;

export const enrolledHostsQuery = {
  ...hostsQuery,
  select: (hosts: HostView[]) => hosts.filter((host) => host.state !== HOST_STATE.revoked),
} as const;

export const homeAssistantQuery = {
  queryKey: ["home-assistant"],
  queryFn: () => api<HomeAssistantView>("GET", API_ROUTES.homeAssistant),
  refetchInterval: INVENTORY_REFRESH_MILLISECONDS,
} as const;

export const overviewQuery = {
  queryKey: ["overview"],
  queryFn: () => api<OverviewView>("GET", API_ROUTES.overview),
  refetchInterval: INVENTORY_REFRESH_MILLISECONDS,
} as const;

export const ollamaQuery = {
  queryKey: ["ollama"],
  queryFn: () => api<OllamaStatusView>("GET", API_ROUTES.ollama),
  refetchInterval: REFRESH_MILLISECONDS,
} as const;

// Where Autoheal asks Ollama, and what: changes only when someone saves it.
export const ollamaServersQuery = {
  queryKey: ["ollama-servers"],
  queryFn: () => api<OllamaServersView>("GET", API_ROUTES.ollamaServers),
  refetchInterval: REFRESH_MILLISECONDS,
} as const;

/** What the dashboard shows of the trust policy: the publishers, the rules, and which policy this is. */
export interface ImageTrustView {
  publishers: { name: string; publicKey: string; keyType: string; createdBy: string; createdAt: number }[];
  rules: { id: string; registry: string; repository: string | null; publishers: string[] }[];
  revision: number;
}

// An application's replicas across the fleet, and how much of it must keep serving.
export const availabilityGroupsQuery = {
  queryKey: ["availability-groups"],
  queryFn: () => api<AvailabilityGroupView[]>("GET", API_ROUTES.availabilityGroups),
  refetchInterval: INVENTORY_REFRESH_MILLISECONDS,
} as const;

// Who is trusted to publish an image, and where a signed one is required.
export const imageTrustQuery = {
  queryKey: ["image-trust"],
  queryFn: () => api<ImageTrustView>("GET", API_ROUTES.imageTrust),
} as const;

// Which private registries are set up, and for which hosts: changes only when an admin saves one.
export const registryCredentialsQuery = {
  queryKey: ["registry-credentials"],
  queryFn: () => api<RegistryCredentialView[]>("GET", API_ROUTES.registryCredentials),
} as const;

export const routerSettingsQuery = {
  queryKey: ["router-settings"],
  queryFn: () => api<RouterSettingsView>("GET", API_ROUTES.routerSettings),
} as const;

export const jarvisQuery = {
  queryKey: ["jarvis"],
  queryFn: () => api<JarvisView>("GET", API_ROUTES.jarvis),
  refetchInterval: REFRESH_MILLISECONDS,
} as const;

export const networkOverviewQuery = {
  queryKey: ["network-overview"],
  queryFn: () => api<NetworkOverviewView>("GET", API_ROUTES.network),
  refetchInterval: REFRESH_MILLISECONDS,
} as const;

export const ollamaSettingsQuery = {
  queryKey: ["ollama-settings"],
  queryFn: () => api<OllamaSettingsView>("GET", API_ROUTES.ollamaSettings),
} as const;

export const settingsQuery = {
  queryKey: ["settings"],
  queryFn: () => api<SettingsView>("GET", API_ROUTES.settings),
} as const;

// Autoheal updating itself: whether it can here, and how its last update went.
export const selfUpdateQuery = {
  queryKey: ["self-update"],
  queryFn: () => api<SelfUpdateView>("GET", API_ROUTES.selfUpdate),
} as const;

// Configuration and observed delivery results; querying this never sends a notification.
export const integrationsQuery = {
  queryKey: ["integrations"],
  queryFn: () => api<IntegrationView[]>("GET", API_ROUTES.integrations),
  refetchInterval: REFRESH_MILLISECONDS,
} as const;

// Every container on every host, as their runners last reported them.
export const containersQuery = {
  queryKey: ["containers", ""],
  queryFn: () => api<ContainerView[]>("GET", API_ROUTES.containers),
  refetchInterval: INVENTORY_REFRESH_MILLISECONDS,
} as const;

// A host's own packages: what its files say, its last check, who takes care of what, its package jobs.
export const hostPackagesQuery = (hostId: string) => ({
  queryKey: ["host-packages", hostId],
  queryFn: () => api<HostPackagesView>("GET", apiPath(API_ROUTES.hostPackages, { hostId })),
});

// Each host's nightly window, and whether Autoheal takes security fixes in it.
export const hostUpdatesQuery = {
  queryKey: ["host-updates"],
  queryFn: () => api<HostUpdateSettingsView>("GET", API_ROUTES.hostUpdateSettings),
} as const;

// The database's backups, newest first; admins only.
export const backupsQuery = {
  queryKey: ["backups"],
  queryFn: () => api<BackupView[]>("GET", API_ROUTES.backups),
} as const;

// A host's latest jobs, the ones on their way with their progress: what its containers' rows are doing now. The live
// stream refreshes them as they move; this refresh covers a dropped stream.
export const hostJobsQuery = (hostId: string) => ({
  queryKey: ["jobs", hostId],
  queryFn: () => api<JobView[]>("GET", `${API_ROUTES.jobs}?${new URLSearchParams({ [JOB_QUERY.hostId]: hostId })}`),
  refetchInterval: INVENTORY_REFRESH_MILLISECONDS,
});

// What is open on one host: its page lists it, and its containers' rows say when an update waits for a person.
export const hostTasksQuery = (hostId: string) => {
  const query = new URLSearchParams({ [TASK_QUERY.status]: TASK_FILTERS.open, [TASK_QUERY.hostId]: hostId });
  return {
    queryKey: ["tasks", "host", hostId],
    queryFn: () => api<TaskSummaryView[]>("GET", `${API_ROUTES.tasks}?${query}`),
    refetchInterval: REFRESH_MILLISECONDS,
  };
};

// One host's containers: the same key as the containers list's for one host, so both follow every change.
export const hostContainersQuery = (hostId: string) => {
  const query = new URLSearchParams({ [CONTAINER_QUERY.hostId]: hostId }).toString();
  return {
    queryKey: ["containers", query],
    queryFn: () => api<ContainerView[]>("GET", `${API_ROUTES.containers}?${query}`),
    staleTime: INVENTORY_REFRESH_MILLISECONDS,
    refetchInterval: INVENTORY_REFRESH_MILLISECONDS,
  };
};

/** Match the list's serialized filters and the task page's existing host key without touching other hosts. */
export function containerQueryMatchesHosts(queryKey: readonly unknown[], hostIds: ReadonlySet<string>): boolean {
  if (queryKey[0] !== "containers" || hostIds.size === 0) return false;
  if (queryKey[1] === "host" && typeof queryKey[2] === "string") return hostIds.has(queryKey[2]);
  // Unknown key shapes are conservatively treated as shared lists.
  if (typeof queryKey[1] !== "string") return true;
  const hostId = new URLSearchParams(queryKey[1]).get(CONTAINER_QUERY.hostId);
  return !hostId || hostIds.has(hostId);
}

// The keys Autoheal signs in to SSH hosts with: an admin's to see.
export const sshKeysQuery = {
  queryKey: ["ssh-keys"],
  queryFn: () => api<SshKeyView[]>("GET", API_ROUTES.sshKeys),
} as const;

// An SSH host's address, user, key and settings, and the host key it offers when that changed.
export const sshHostQuery = (hostId: string) =>
  ({
    queryKey: ["ssh-host", hostId],
    queryFn: () => api<SshHostDetailsView>("GET", apiPath(API_ROUTES.sshHost, { hostId })),
    refetchInterval: REFRESH_MILLISECONDS,
  }) as const;
