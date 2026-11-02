import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerClient } from "./docker-client.js";
// Exercise the production request construction without needing a local socket listener.
function transport() {
  const docker = new DockerClient("/unused-test-socket");
  const request = vi
    .spyOn(
      docker as unknown as { request: (...args: unknown[]) => Promise<{ status: number; body: Buffer }> },
      "request",
    )
    .mockResolvedValue({ status: 204, body: Buffer.alloc(0) });
  return { docker, request };
}
afterEach(() => vi.restoreAllMocks());
describe("rollback Docker transport", () => {
  it("passes the stop grace and removes without force or volume deletion", async () => {
    const { docker, request } = transport();
    await docker.stop("replacement-id", 37);
    await docker.removeStopped("replacement-id");
    expect(request.mock.calls[0]).toEqual(["POST", "/containers/replacement-id/stop", { t: "37" }]);
    expect(request.mock.calls[1]).toEqual(["DELETE", "/containers/replacement-id"]);
  });
  it("returns a removal conflict without retrying with force", async () => {
    const { docker, request } = transport();
    request.mockResolvedValue({ status: 409, body: Buffer.from('{"message":"container is running"}') });
    await expect(docker.removeStopped("replacement-id")).rejects.toThrow("409");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
