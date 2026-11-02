import { setTimeout as wait } from "node:timers/promises";
import { backupKeyAnswerSchema, type BackupAnswer } from "../shared/container-backups.js";
import type { StackAnswer } from "../shared/stacks.js";
import type { VolumeLookAnswer } from "../shared/volumes.js";
import { applicationArtifactStream } from "../shared/application-artifact-stream.js";
import {
  APPLICATION_BACKUPS,
  applicationBackupTaskSchema,
  applicationBackupResultSchema,
  type ApplicationBackupTask,
  type ApplicationBackupResult,
} from "../shared/application-backups.js";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import type { OperationPreviewAnswer } from "../shared/topology.js";
import type { ResourceTarget } from "../shared/resource-permissions.js";
import type { IncomingMessage } from "node:http";
import { Agent, request, type RequestOptions } from "node:https";
import type { Duplex } from "node:stream";
import { text } from "node:stream/consumers";
import { connect, type ConnectionOptions } from "node:tls";
import { apiPath } from "../shared/api.js";
import {
  BEARER_PREFIX,
  RUNNER_CAPABILITIES,
  CONTROL_PLANE_TIMEOUT_MILLISECONDS,
  HTTP_HEADERS,
  HTTP_STATUS,
  HTTP_SUCCESS,
  JSON_CONTENT_TYPE,
  TAR_CONTENT_TYPE,
  TERMINAL_INPUT_WAIT_MILLISECONDS,
  TLS_MESSAGES,
  INSTALL_FETCH,
} from "../shared/constants.js";
import { installDetailsSchema, type InstallAnswer, type InstallDetails } from "../shared/install.js";
import { publicKeyPin } from "../shared/hash.js";
import {
  RUNNER_ROUTES,
  containerSettingsSchema,
  type ContainerAccessWork,
  type ContainerSettings,
  type DecisionResponse,
  type FileAnswer,
  type HostProfileAnswer,
  type SettingsAnswer,
  type HandledIncident,
  type Heartbeat,
  type HeartbeatResponse,
  type IncidentNotice,
  type IncidentSubmission,
  type JobProgress,
  type JobResult,
  type MetricsReport,
  type Outcome,
  type TerminalEnd,
  type TerminalInput,
  type WorkResponse,
} from "../shared/protocol.js";
import { joinUrl } from "../shared/urls.js";

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`HTTP ${status} ${body}`);
  }
}

// What the control plane answers a result it will never take: its job is over (it has its result already, or never
// had this job), or it holds a different result for it. Sending it again cannot change that.
const REFUSED_FOR_GOOD: readonly number[] = [HTTP_STATUS.notFound, HTTP_STATUS.conflict];

/** Whether the control plane refused a result for good, rather than for now (busy, too many requests, away). */
export const refusedForGood = (error: unknown) =>
  error instanceof ControlPlaneError && REFUSED_FOR_GOOD.includes(error.status);

/** The server showed a certificate that is neither trusted here nor the one the join code names. */
export class PinMismatchError extends Error {
  constructor() {
    super(TLS_MESSAGES.pinMismatch);
  }
}

/** Where the control plane is, the token to show it, and its public key when a join code named it. */
export interface ControlPlaneConnection {
  url: string;
  token: string;
  // Null for a runner set up before join codes: it trusts the control plane through a CA only.
  pin: string | null;
}

/**
 * Hands a connection to the request only once the control plane proved who it is: a certificate
 * this machine already trusts for that address (an operator's own CA), or the public key the join
 * code names. Nothing of the request is sent before that.
 */
class PinnedAgent extends Agent {
  constructor(private readonly pin: string) {
    // No TLS session reuse: every connection shows its certificate again.
    super({ keepAlive: true, maxCachedSessions: 0 });
  }

  override createConnection(options: RequestOptions, callback?: (error: Error | null, stream: Duplex) => void) {
    const socket = connect({ ...(options as ConnectionOptions), rejectUnauthorized: false });
    const failed = (error: Error) => {
      socket.destroy();
      callback?.(error, socket);
    };
    socket.once("error", failed);
    socket.once("secureConnect", () => {
      socket.off("error", failed);
      const certificate = socket.getPeerX509Certificate();
      const pinned = certificate !== undefined && publicKeyPin(certificate.publicKey) === this.pin;
      if (!socket.authorized && !pinned) {
        failed(new PinMismatchError());
        return;
      }
      callback?.(null, socket);
    });
    return undefined;
  }
}

const agentFor = (connection: ControlPlaneConnection) =>
  connection.pin === null ? new Agent({ keepAlive: true }) : new PinnedAgent(connection.pin);

/** The runner's side of the runner API, over TLS that is always verified. */
export class ControlPlaneClient {
  private agent: Agent;
  private resultProtocol: Promise<void> | null = null;

  /**
   * `reload` reads the join code again when the control plane's key changed, or it refused the token: either way
   * it may have written a new code (a new key; this machine's runner added again after it was revoked).
   */
  constructor(
    private connection: ControlPlaneConnection,
    private readonly reload: (() => ControlPlaneConnection | null) | null = null,
  ) {
    this.agent = agentFor(connection);
  }

  heartbeat(heartbeat: Heartbeat): Promise<HeartbeatResponse | null> {
    return this.post(RUNNER_ROUTES.heartbeat, heartbeat) as Promise<HeartbeatResponse | null>;
  }

  /** Fresh per-request authorization; only an explicit affirmative reply permits delegated work. */
  async authorizeOperatorJob(jobId: string, members: readonly Omit<ResourceTarget, "hostId">[]): Promise<boolean> {
    return this.authorized(apiPath(RUNNER_ROUTES.jobAuthorization, { jobId }), members);
  }

  async authorizeOperatorAccess(
    kind: "terminal" | "file" | "settings",
    requestId: string,
    member: Omit<ResourceTarget, "hostId">,
  ): Promise<boolean> {
    const routes = {
      terminal: RUNNER_ROUTES.terminalAuthorization,
      file: RUNNER_ROUTES.fileAuthorization,
      settings: RUNNER_ROUTES.settingsAuthorization,
    };
    return this.authorized(apiPath(routes[kind], { requestId }), [member]);
  }

  private async authorized(path: string, members: readonly Omit<ResourceTarget, "hostId">[]): Promise<boolean> {
    try {
      const answer = await this.post(path, { members });
      return (answer as { authorized?: unknown } | null)?.authorized === true;
    } catch {
      return false;
    }
  }

  /** Tasks are durably claimed once by the server, separately from container jobs/access. */
  async takeApplicationBackupWork(stopping?: AbortSignal): Promise<ApplicationBackupTask[]> {
    const signal = AbortSignal.timeout(CONTROL_PLANE_TIMEOUT_MILLISECONDS);
    const response = await this.send(
      "GET",
      RUNNER_ROUTES.applicationBackupWork,
      undefined,
      stopping ? AbortSignal.any([signal, stopping]) : signal,
    );
    return z
      .object({ tasks: z.array(applicationBackupTaskSchema).max(1) })
      .strict()
      .parse(response).tasks;
  }

  async authorizeApplicationBackup(taskId: string, attempt: number): Promise<boolean> {
    try {
      const response = await this.post(apiPath(RUNNER_ROUTES.applicationBackupAuthorization, { taskId }), { attempt });
      return (response as { allowed?: unknown } | null)?.allowed === true;
    } catch {
      return false;
    }
  }

  reportApplicationBackup(result: ApplicationBackupResult): Promise<unknown> {
    return this.post(RUNNER_ROUTES.applicationBackupResult, applicationBackupResultSchema.parse(result));
  }

  /** Ciphertext only, bounded in both directions, through the same verified TLS agent as JSON work. */
  async uploadApplicationBackup(taskId: string, artifactId: string, source: Readable, attempt = 0): Promise<unknown> {
    const route =
      apiPath(RUNNER_ROUTES.applicationBackupUpload, { taskId, artifactId }) +
      `?${new URLSearchParams({ attempt: String(attempt) })}`;
    const signal = AbortSignal.timeout(APPLICATION_BACKUPS.transferMilliseconds);
    let outgoing: ReturnType<typeof request> | undefined;
    let transfer: Promise<void> | undefined;
    let incoming: IncomingMessage | undefined;
    try {
      const response = new Promise<unknown>((resolve, reject) => {
        outgoing = request(
          joinUrl(this.connection.url, route),
          {
            method: "POST",
            agent: this.agent,
            signal,
            headers: {
              [HTTP_HEADERS.contentType]: TAR_CONTENT_TYPE,
              [HTTP_HEADERS.runnerCapabilities]: RUNNER_CAPABILITIES,
              [HTTP_HEADERS.authorization]: `${BEARER_PREFIX}${this.connection.token}`,
            },
          },
          (received) => {
            incoming = received;
            void this.applicationResponse(received).then(resolve, reject);
          },
        );
        outgoing.on("error", (error) => {
          if (error instanceof PinMismatchError) this.reconnectIfJoinChanged();
          reject(error);
        });
        transfer = pipeline(source, applicationArtifactStream(), outgoing);
        void transfer.catch(reject);
      });
      const [answer] = await Promise.all([response, transfer]);
      return answer;
    } catch (error) {
      source.destroy();
      outgoing?.destroy();
      incoming?.destroy();
      throw error;
    }
  }

  async downloadApplicationBackup(taskId: string, artifactId: string, attempt = 0): Promise<Readable> {
    const route =
      apiPath(RUNNER_ROUTES.applicationBackupDownload, { taskId, artifactId }) +
      `?${new URLSearchParams({ attempt: String(attempt) })}`;
    const response = await this.request(
      "GET",
      route,
      undefined,
      AbortSignal.timeout(APPLICATION_BACKUPS.transferMilliseconds),
    );
    const status = response.statusCode ?? 0;
    if (status < HTTP_SUCCESS.from || status > HTTP_SUCCESS.through) {
      await this.applicationResponse(response);
      throw new ControlPlaneError(status, "Application backup download failed.");
    }
    const verified = applicationArtifactStream();
    void pipeline(response, verified).catch((error) => verified.destroy(error as Error));
    return verified;
  }

  private async applicationResponse(response: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 64 * 1024) throw new Error("Application API response exceeded its limit.");
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString();
      const status = response.statusCode ?? 0;
      if (status < HTTP_SUCCESS.from || status > HTTP_SUCCESS.through) {
        if (status === HTTP_STATUS.unauthorized) this.reconnectIfJoinChanged();
        throw new ControlPlaneError(status, body);
      }
      return body ? JSON.parse(body) : null;
    } catch (error) {
      response.destroy();
      throw error;
    }
  }

  reportMetrics(report: MetricsReport): Promise<unknown> {
    return this.post(RUNNER_ROUTES.metrics, report);
  }

  submitIncident(submission: IncidentSubmission, signal: AbortSignal): Promise<DecisionResponse> {
    return this.post(RUNNER_ROUTES.incidents, submission, signal) as Promise<DecisionResponse>;
  }

  reportOutcome(incidentId: string, outcome: Outcome): Promise<unknown> {
    return this.postResult(apiPath(RUNNER_ROUTES.incidentOutcome, { incidentId }), outcome);
  }

  submitHandled(handled: HandledIncident): Promise<unknown> {
    return this.postResult(RUNNER_ROUTES.handledIncidents, handled);
  }

  async takeWork(): Promise<WorkResponse> {
    const response = (await this.send("GET", RUNNER_ROUTES.work)) as Partial<WorkResponse>;
    return { items: response.items ?? [], jobs: response.jobs ?? [] };
  }

  /** Shells to open and files to reach: the control plane answers as soon as one is asked for, or after a while. */
  takeContainerAccessWork(stopping: AbortSignal): Promise<ContainerAccessWork> {
    const waited = AbortSignal.timeout(TERMINAL_INPUT_WAIT_MILLISECONDS + CONTROL_PLANE_TIMEOUT_MILLISECONDS);
    const signal = AbortSignal.any([waited, stopping]);
    return this.send("GET", RUNNER_ROUTES.containerAccess, undefined, signal) as Promise<ContainerAccessWork>;
  }

  reportOperationPreview(requestId: string, answer: OperationPreviewAnswer): Promise<unknown> {
    return this.post(apiPath(RUNNER_ROUTES.operationPreviewAnswer, { requestId }), answer);
  }

  reportFileAnswer(requestId: string, answer: FileAnswer): Promise<unknown> {
    return this.post(apiPath(RUNNER_ROUTES.fileAnswer, { requestId }), answer);
  }

  reportInstall(requestId: string, answer: InstallAnswer): Promise<unknown> {
    return this.post(apiPath(RUNNER_ROUTES.installAnswer, { requestId }), answer);
  }

  /**
   * An install's details, checked like anything else from outside. Asked again while the control plane cannot answer:
   * asking runs nothing, and giving up would fail an install that was about to work. A refusal is final.
   */
  async jobInstall(jobId: string, pause: (milliseconds: number) => Promise<unknown> = wait): Promise<InstallDetails> {
    for (let attempt = 1; ; attempt += 1) {
      const answer = await this.send("GET", apiPath(RUNNER_ROUTES.jobInstall, { jobId })).then(
        (details: unknown) => ({ details }),
        (error: unknown) => ({ error }),
      );
      if ("details" in answer) return installDetailsSchema.parse(answer.details);
      const { error } = answer;
      const refused = error instanceof ControlPlaneError && error.status < HTTP_STATUS.internalServerError;
      if (refused || attempt >= INSTALL_FETCH.attempts) throw error;
      await pause(INSTALL_FETCH.pauseMilliseconds);
    }
  }

  reportHostProfile(requestId: string, answer: HostProfileAnswer): Promise<unknown> {
    return this.post(apiPath(RUNNER_ROUTES.hostProfileAnswer, { requestId }), answer);
  }

  reportBackup(requestId: string, answer: BackupAnswer): Promise<unknown> {
    return this.post(apiPath(RUNNER_ROUTES.backupAnswer, { requestId }), answer);
  }

  async openBackupKey(jobId: string, sealedKey: string): Promise<string> {
    const answer = await this.send("POST", apiPath(RUNNER_ROUTES.jobBackupKey, { jobId }), { sealedKey });
    return backupKeyAnswerSchema.parse(answer).identity;
  }

  reportStack(requestId: string, answer: StackAnswer): Promise<unknown> {
    return this.post(apiPath(RUNNER_ROUTES.stackAnswer, { requestId }), answer);
  }

  reportVolumeLook(requestId: string, answer: VolumeLookAnswer): Promise<unknown> {
    return this.post(apiPath(RUNNER_ROUTES.volumeLookAnswer, { requestId }), answer);
  }

  reportSettingsAnswer(requestId: string, answer: SettingsAnswer): Promise<unknown> {
    return this.post(apiPath(RUNNER_ROUTES.settingsAnswer, { requestId }), answer);
  }

  /** The settings an edit job applies: given once, and checked like anything else from the control plane. */
  async jobSettings(jobId: string): Promise<ContainerSettings> {
    return containerSettingsSchema.parse(await this.send("GET", apiPath(RUNNER_ROUTES.jobSettings, { jobId })));
  }

  /** A shell's keystrokes: the control plane answers as soon as some come, or after a while with none. */
  terminalInput(terminalId: string): Promise<TerminalInput> {
    const signal = AbortSignal.timeout(TERMINAL_INPUT_WAIT_MILLISECONDS + CONTROL_PLANE_TIMEOUT_MILLISECONDS);
    return this.send(
      "GET",
      apiPath(RUNNER_ROUTES.terminalInput, { terminalId }),
      undefined,
      signal,
    ) as Promise<TerminalInput>;
  }

  terminalOutput(terminalId: string, data: string): Promise<unknown> {
    return this.post(apiPath(RUNNER_ROUTES.terminalOutput, { terminalId }), { data });
  }

  terminalEnd(terminalId: string, end: TerminalEnd): Promise<unknown> {
    return this.post(apiPath(RUNNER_ROUTES.terminalEnd, { terminalId }), end);
  }

  reportWorkResult(workItemId: string, outcome: Outcome): Promise<unknown> {
    return this.postResult(apiPath(RUNNER_ROUTES.workResult, { workItemId }), outcome);
  }

  reportJobResult(jobId: string, result: JobResult): Promise<unknown> {
    return this.postResult(apiPath(RUNNER_ROUTES.jobResult, { jobId }), result);
  }

  reportJobProgress(jobId: string, progress: JobProgress): Promise<unknown> {
    return this.post(apiPath(RUNNER_ROUTES.jobProgress, { jobId }), progress);
  }

  notify(notice: IncidentNotice): Promise<unknown> {
    return this.post(RUNNER_ROUTES.notifications, notice);
  }

  private async postResult(path: string, body: unknown) {
    // An older server can create duplicate local incidents after a lost response. Upgrade it first.
    this.resultProtocol ??= this.send("GET", RUNNER_ROUTES.resultDelivery)
      .then((reply) => {
        if ((reply as { version?: number } | null)?.version !== 1)
          throw new Error("Control plane needs durable result delivery support.");
      })
      .catch((error: unknown) => {
        this.resultProtocol = null;
        throw error;
      });
    await this.resultProtocol;
    return this.post(path, body);
  }

  private post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.send("POST", path, body, signal);
  }

  private async send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(
      method,
      path,
      body,
      signal ?? AbortSignal.timeout(CONTROL_PLANE_TIMEOUT_MILLISECONDS),
    );
    const content = await text(response);
    const status = response.statusCode ?? 0;
    if (status < HTTP_SUCCESS.from || status > HTTP_SUCCESS.through) {
      if (status === HTTP_STATUS.unauthorized) {
        this.reconnectIfJoinChanged();
      }
      throw new ControlPlaneError(status, content);
    }
    return content.length > 0 ? JSON.parse(content) : null;
  }

  private request(method: string, path: string, body: unknown, signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const outgoing = request(
        joinUrl(this.connection.url, path),
        {
          method,
          agent: this.agent,
          signal,
          headers: {
            [HTTP_HEADERS.contentType]: JSON_CONTENT_TYPE,
            [HTTP_HEADERS.runnerCapabilities]: RUNNER_CAPABILITIES,
            [HTTP_HEADERS.authorization]: `${BEARER_PREFIX}${this.connection.token}`,
          },
        },
        resolve,
      );
      outgoing.on("error", (error) => {
        if (error instanceof PinMismatchError) {
          this.reconnectIfJoinChanged();
        }
        reject(error);
      });
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  // The next request uses the new code; this one has failed already.
  private reconnectIfJoinChanged() {
    const fresh = this.reload?.() ?? null;
    const unchanged = fresh?.pin === this.connection.pin && fresh.token === this.connection.token;
    if (fresh === null || unchanged) {
      return;
    }
    this.agent.destroy();
    this.connection = fresh;
    this.agent = agentFor(fresh);
    this.resultProtocol = null;
  }
}
