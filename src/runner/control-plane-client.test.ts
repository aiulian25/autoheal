import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownCertificate, providedCertificate, type ServerCertificate } from "../control-plane/tls/certificate.js";
import { INSTALL_FETCH } from "../shared/constants.js";
import {
  ControlPlaneClient,
  ControlPlaneError,
  JoinCodeRefusedError,
  PinMismatchError,
  redeemJoinCode,
  refusedForGood,
} from "./control-plane-client.js";

const TOKEN = `ahk_${"a".repeat(43)}`;
const FIXTURES = join(import.meta.dirname, "../../test/fixtures/tls");
const WORK = { items: [], jobs: [] };

describe("the runner's connection to the control plane", () => {
  let directory: string;
  let server: Server;
  let requests: string[];

  const serve = async (material: ServerCertificate) => {
    server = createServer({ key: material.key, cert: material.certificate }, (request, response) => {
      requests.push(`${request.method} ${request.url} ${request.headers.authorization}`);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(WORK));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "autoheal-pin-"));
    requests = [];
  });

  afterEach(() => {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires an explicit affirmative authorization tied to the job or access request, and denies provider errors", async () => {
    const material = ownCertificate(directory, ["127.0.0.1"], Date.now()).material;
    let mode: "yes" | "no" | "malformed" = "yes";
    const bodies: unknown[] = [];
    server = createServer({ key: material.key, cert: material.certificate }, (request, response) => {
      requests.push(`${request.method} ${request.url} ${request.headers.authorization}`);
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        bodies.push(JSON.parse(body));
        response.statusCode = mode === "no" ? 403 : 200;
        response.end(JSON.stringify(mode === "malformed" ? { authorized: "true" } : { authorized: mode === "yes" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new ControlPlaneClient({
      url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: TOKEN,
      pin: material.pin,
    });
    const member = { name: "db", composeProject: "documents" };
    expect(await client.authorizeOperatorJob("job-id", [member])).toBe(true);
    expect(await client.authorizeOperatorAccess("terminal", "request-id", member)).toBe(true);
    mode = "no";
    expect(await client.authorizeOperatorJob("job-id", [member])).toBe(false);
    mode = "malformed";
    expect(await client.authorizeOperatorAccess("file", "request-id", member)).toBe(false);
    expect(requests[0]).toBe(`POST /runner/v1/jobs/job-id/authorize Bearer ${TOKEN}`);
    expect(requests[1]).toBe(`POST /runner/v1/terminals/request-id/authorize Bearer ${TOKEN}`);
    expect(bodies).toEqual(Array.from({ length: 4 }, () => ({ members: [member] })));
  });

  it("trusts the certificate Autoheal made by the key its join code names, at any address", async () => {
    const material = ownCertificate(directory, ["autoheal.example.org"], Date.now()).material;
    const url = await serve(material);
    const client = new ControlPlaneClient({ url, token: TOKEN, pin: material.pin });
    await expect(client.takeWork()).resolves.toEqual(WORK);
    expect(requests).toEqual([`GET /runner/v1/work Bearer ${TOKEN}`]);
  });

  it("trades a join code with no token on the request, and tells a refusal from a failure", async () => {
    const material = ownCertificate(directory, ["127.0.0.1"], Date.now()).material;
    const answers = [204, 401, 503];
    const bodies: unknown[] = [];
    server = createServer({ key: material.key, cert: material.certificate }, (request, response) => {
      requests.push(`${request.method} ${request.url} ${request.headers.authorization}`);
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        bodies.push(JSON.parse(body));
        response.statusCode = answers.shift()!;
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const code = { url, enrolment: `ahe_${"E".repeat(43)}`, pin: material.pin };

    await expect(redeemJoinCode(code, TOKEN)).resolves.toBeUndefined();
    await expect(redeemJoinCode(code, TOKEN)).rejects.toBeInstanceOf(JoinCodeRefusedError);
    await expect(redeemJoinCode(code, TOKEN)).rejects.toBeInstanceOf(ControlPlaneError);
    expect(requests).toEqual(Array.from({ length: 3 }, () => "POST /runner/v1/join undefined"));
    expect(bodies).toEqual(Array.from({ length: 3 }, () => ({ enrolment: code.enrolment, token: TOKEN })));

    const other = ownCertificate(join(directory, "other"), ["127.0.0.1"], Date.now()).material;
    await expect(redeemJoinCode({ ...code, pin: other.pin }, TOKEN)).rejects.toBeInstanceOf(PinMismatchError);
    expect(requests).toHaveLength(3);
  });

  it("refuses any other key before sending anything, token included", async () => {
    const material = ownCertificate(directory, ["127.0.0.1"], Date.now()).material;
    const url = await serve(material);
    const other = ownCertificate(join(directory, "other"), ["127.0.0.1"], Date.now()).material;
    const client = new ControlPlaneClient({ url, token: TOKEN, pin: other.pin });
    await expect(client.takeWork()).rejects.toBeInstanceOf(PinMismatchError);
    expect(requests).toEqual([]);
  });

  it("also takes a certificate this machine trusts for that address, as with an operator's own CA", async () => {
    const material = providedCertificate({
      certificateFile: join(FIXTURES, "server.pem"),
      keyFile: join(FIXTURES, "server-key.pem"),
    });
    const port = new URL(await serve(material)).port;
    const strangerPin = ownCertificate(directory, ["localhost"], Date.now()).material.pin;
    const client = new ControlPlaneClient({ url: `https://localhost:${port}`, token: TOKEN, pin: strangerPin });
    await expect(client.takeWork()).resolves.toEqual(WORK);
  });

  it("reads its join code again when the control plane's key changed, and uses the new one", async () => {
    const before = ownCertificate(join(directory, "before"), ["127.0.0.1"], Date.now()).material;
    const after = ownCertificate(join(directory, "after"), ["127.0.0.1"], Date.now()).material;
    const url = await serve(after);
    const client = new ControlPlaneClient({ url, token: TOKEN, pin: before.pin }, () => ({
      url,
      token: TOKEN,
      pin: after.pin,
    }));
    await expect(client.takeWork()).rejects.toBeInstanceOf(PinMismatchError);
    await expect(client.takeWork()).resolves.toEqual(WORK);
  });

  it("reads its join code again when its token is refused, and uses the new one", async () => {
    const material = ownCertificate(join(directory, "key"), ["127.0.0.1"], Date.now()).material;
    // This machine's runner, added again from the dashboard: a new token waits in its join file.
    const fresh = `ahk_${"b".repeat(43)}`;
    server = createServer({ key: material.key, cert: material.certificate }, (request, response) => {
      requests.push(request.headers.authorization ?? "");
      response.setHeader("content-type", "application/json");
      response.statusCode = request.headers.authorization === `Bearer ${fresh}` ? 200 : 401;
      response.end(JSON.stringify(response.statusCode === 200 ? WORK : { error: "unknown_runner" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let reads = 0;
    const client = new ControlPlaneClient({ url, token: TOKEN, pin: material.pin }, () => {
      reads += 1;
      return { url, token: fresh, pin: material.pin };
    });
    await expect(client.takeWork()).rejects.toMatchObject({ status: 401 });
    await expect(client.takeWork()).resolves.toEqual(WORK);
    expect(requests).toEqual([`Bearer ${TOKEN}`, `Bearer ${fresh}`]);
    expect(reads).toBe(1);
  });
  it("does not post results to a server without idempotent delivery support", async () => {
    const material = ownCertificate(directory, ["127.0.0.1"], Date.now()).material;
    const url = await serve(material);
    const client = new ControlPlaneClient({ url, token: TOKEN, pin: material.pin });
    await expect(client.reportJobResult("job", { succeeded: true, outcome: "done", output: null })).rejects.toThrow(
      "durable result delivery support",
    );
    expect(requests).toEqual([`GET /runner/v1/result-delivery Bearer ${TOKEN}`]);
  });

  it("negotiates delivery support before posting a result, and retries a failed negotiation", async () => {
    const material = ownCertificate(directory, ["127.0.0.1"], Date.now()).material;
    let compatible = false;
    const paths: string[] = [];
    server = createServer({ key: material.key, cert: material.certificate }, (request, response) => {
      paths.push(request.url!);
      if (request.url === "/runner/v1/result-delivery") response.end(JSON.stringify({ version: compatible ? 1 : 0 }));
      else {
        response.statusCode = 204;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new ControlPlaneClient({
      url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: TOKEN,
      pin: material.pin,
    });
    const result = { succeeded: true, outcome: "done", output: null };
    await expect(client.reportJobResult("job", result)).rejects.toThrow("delivery support");
    compatible = true;
    await client.reportJobResult("job", result);
    await client.reportJobResult("job", result);
    expect(paths).toEqual([
      "/runner/v1/result-delivery",
      "/runner/v1/result-delivery",
      "/runner/v1/jobs/job/result",
      "/runner/v1/jobs/job/result",
    ]);
  });

  it("keeps a result to send again when the server cannot say how it takes results, never as refused", async () => {
    const material = ownCertificate(directory, ["127.0.0.1"], Date.now()).material;
    let upgraded = false;
    const paths: string[] = [];
    server = createServer({ key: material.key, cert: material.certificate }, (request, response) => {
      paths.push(request.url!);
      const asking = request.url === "/runner/v1/result-delivery";
      // An older control plane has no such route: it answers as it would a result it will never take.
      response.statusCode = asking ? (upgraded ? 200 : 404) : 204;
      response.end(asking ? JSON.stringify(upgraded ? { version: 1 } : { error: "not_found" }) : undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new ControlPlaneClient({
      url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: TOKEN,
      pin: material.pin,
    });
    const result = { succeeded: true, outcome: "done", output: null };

    const failure = await client.reportJobResult("job", result).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(refusedForGood(failure)).toBe(false);

    upgraded = true;
    await client.reportJobResult("job", result);
    expect(paths).toEqual(["/runner/v1/result-delivery", "/runner/v1/result-delivery", "/runner/v1/jobs/job/result"]);
  });

  describe("asking for an install's details", () => {
    const SPEC = { own: true, folder: "/srv/stacks/wiki", compose: "services: {}\n", env: "", retry: null };
    const serving = async (answers: ((response: ServerResponse) => void)[]) => {
      const asked: string[] = [];
      const material = ownCertificate(directory, ["127.0.0.1"], Date.now()).material;
      server = createServer({ key: material.key, cert: material.certificate }, (request, response) => {
        asked.push(request.url!);
        answers.shift()!(response);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const client = new ControlPlaneClient({
        url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
        token: TOKEN,
        pin: material.pin,
      });
      return { client, asked };
    };
    const noPause = async () => undefined;
    const dropped = (response: ServerResponse) => void response.destroy();
    const status = (code: number) => (response: ServerResponse) => {
      response.statusCode = code;
      response.end("{}");
    };
    const theSpec = (response: ServerResponse) => void response.end(JSON.stringify(SPEC));

    it("asks again after a reply lost on the way, or a control plane restarting", async () => {
      const { client, asked } = await serving([dropped, status(503), theSpec]);
      expect(await client.jobInstall("job", noPause)).toMatchObject({ folder: SPEC.folder });
      expect(asked).toHaveLength(3);
    });

    it("takes no for an answer", async () => {
      const { client, asked } = await serving([status(404)]);
      await expect(client.jobInstall("job", noPause)).rejects.toThrow("404");
      expect(asked).toHaveLength(1);
    });

    it("gives up in the end", async () => {
      const answers = Array.from({ length: INSTALL_FETCH.attempts }, () => status(503));
      const { client, asked } = await serving(answers);
      await expect(client.jobInstall("job", noPause)).rejects.toThrow("503");
      expect(asked).toHaveLength(INSTALL_FETCH.attempts);
    });
  });
});
