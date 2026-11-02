import { connect } from "node:net";
import type { Duplex } from "node:stream";
import type { DockerConnection } from "./docker-client.js";

/** The local engine's unix socket; a failed dial surfaces as the request's error. */
export class LocalDockerConnection implements DockerConnection {
  constructor(private readonly socketPath: string) {}

  connect(): Promise<Duplex> {
    return Promise.resolve(connect(this.socketPath));
  }
}
