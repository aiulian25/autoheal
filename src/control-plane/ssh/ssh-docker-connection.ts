import type { Duplex } from "node:stream";
import type { DockerConnection } from "../../runner/docker-client.js";
import type { SshSession } from "./ssh-session.js";

/** A host's Docker socket through its SSH session: each request is a new channel on the one connection. */
export class SshDockerConnection implements DockerConnection {
  constructor(private readonly session: SshSession) {}

  async connect(): Promise<Duplex> {
    return this.session.docker();
  }
}
