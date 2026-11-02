import { describe, expect, it } from "vitest";
import { DOCKER_RUN_TEXT } from "./constants.js";
import { DOCKER_RUN_COMMAND, dockerRunToCompose, shellWords, type ConvertedRun } from "./docker-run.js";

const converted = (command: string) => {
  const result = dockerRunToCompose(command);
  if ("problem" in result) throw new Error(result.problem);
  return result as ConvertedRun;
};

describe("reading a docker run command", () => {
  it("splits words as a shell does", () => {
    expect(shellWords(`docker run -e "A=b c" -e 'D=e f' \\\n  img`)).toEqual([
      "docker",
      "run",
      "-e",
      "A=b c",
      "-e",
      "D=e f",
      "img",
    ]);
  });

  it("knows one when it sees one", () => {
    expect(DOCKER_RUN_COMMAND.test("sudo docker run nginx")).toBe(true);
    expect(DOCKER_RUN_COMMAND.test("docker container run nginx")).toBe(true);
    expect(DOCKER_RUN_COMMAND.test("docker ps")).toBe(false);
  });

  it("turns a full command into a Compose file, with passwords and IDs in the .env", () => {
    const { compose, env, leftOut, suggestedName } = converted(
      `docker run -d --name Wiki --restart unless-stopped -p 3000:3000 -e TZ=UTC -e PUID=1000 -e DB_PASS='s3 cret' -v /srv/wiki:/data -v cache:/cache --network npm ghcr.io/x/wiki:2 --flag`,
    );
    expect(suggestedName).toBe("wiki");
    expect(leftOut).toEqual([]);
    expect(compose).toContain("  wiki:\n    image: ghcr.io/x/wiki:2\n    container_name: Wiki\n");
    expect(compose).toContain('    restart: "unless-stopped"\n');
    expect(compose).toContain('      - "3000:3000"\n');
    expect(compose).toContain("      - TZ=UTC\n      - PUID=${PUID}\n      - DB_PASS=${DB_PASS}\n");
    expect(compose).not.toContain("s3 cret");
    expect(env).toBe("PUID=1000\nDB_PASS='s3 cret'\n");
    expect(compose).toContain("      - /srv/wiki:/data\n      - cache:/cache\n");
    expect(compose).toContain("volumes:\n  cache:\n    name: cache\n");
    expect(compose).toContain("networks:\n  npm:\n    external: true\n");
    expect(compose).toContain('command: ["--flag"]');
  });

  it("gives host networking its own line, and takes short flags together", () => {
    const { compose } = converted("docker run -dit --net=host --privileged alpine");
    expect(compose).toContain("network_mode: host");
    expect(compose).toContain("privileged: true");
    expect(compose).toContain("tty: true");
    expect(compose).toContain("stdin_open: true");
    expect(compose).not.toContain("networks:");
  });

  it("writes a dollar so that Compose reads a dollar", () => {
    expect(converted("docker run -e PRICE='a$b' alpine").compose).toContain("- PRICE=a$$b\n");
  });

  it("says what it did not carry over, rather than losing it quietly", () => {
    expect(converted("docker run --oom-score-adj=5 -P alpine").leftOut).toEqual(["--oom-score-adj=5", "-P"]);
  });

  it("stops at the end of the command", () => {
    expect(converted("docker run alpine && echo done").compose).not.toContain("echo");
  });

  it("says when there is no image", () => {
    expect(dockerRunToCompose("docker run -d")).toEqual({ problem: DOCKER_RUN_TEXT.noImage });
  });
});
