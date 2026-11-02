import { connect, type AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createServer } from "./fastify.js";

const BODY_LIMIT_BYTES = 1024;
const LOOPBACK = "127.0.0.1";

it("closes without waiting for a connection that never sent a request", async () => {
  const app = createServer({ tls: null, isTrustedProxy: null, bodyLimit: BODY_LIMIT_BYTES });
  await app.listen({ host: LOOPBACK, port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const silent = connect(port, LOOPBACK);
  silent.on("error", () => undefined);
  await new Promise((resolve) => silent.once("connect", resolve));

  await app.close();

  silent.destroy();
  expect(app.server.listening).toBe(false);
});
