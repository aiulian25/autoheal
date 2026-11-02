import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MILLISECONDS_PER_DAY, SECRET_FILE_MODE } from "../../shared/constants.js";
import { publicKeyPin } from "../../shared/hash.js";
import { ownCertificate, providedCertificate, type ServerCertificate } from "./certificate.js";

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const NAMES = ["192.168.10.83", "localhost"];
const FILE_MODE_BITS = 0o777;

// The pin a client sees in a real handshake with this material.
async function pinSeenByClient(material: ServerCertificate): Promise<string> {
  const server = createServer({ key: material.key, cert: material.certificate }, (_request, response) =>
    response.end(),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    return await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
        resolve(publicKeyPin(socket.getPeerX509Certificate()!.publicKey));
        socket.end();
      });
      socket.on("error", reject);
    });
  } finally {
    server.close();
  }
}

describe("the certificate Autoheal makes for itself", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "autoheal-tls-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("is a server certificate for the dashboard's names, signed by its own key, which only it can read", () => {
    const { material, issued } = ownCertificate(directory, NAMES, NOW);
    const certificate = new X509Certificate(material.certificate);
    expect(issued).toBe(true);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.ca).toBe(false);
    expect(certificate.subjectAltName).toBe("IP Address:192.168.10.83, DNS:localhost");
    expect(certificate.checkIP("192.168.10.83")).toBe("192.168.10.83");
    expect(certificate.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(Date.parse(certificate.validTo)).toBeGreaterThan(NOW + 800 * MILLISECONDS_PER_DAY);
    expect(material.pin).toBe(publicKeyPin(certificate.publicKey));
    expect(statSync(join(directory, "key.pem")).mode & FILE_MODE_BITS).toBe(SECRET_FILE_MODE);
  });

  it("keeps its key for good, so runners' pins survive a new address and a renewal", () => {
    const first = ownCertificate(directory, NAMES, NOW);
    const again = ownCertificate(directory, NAMES, NOW + MILLISECONDS_PER_DAY);
    expect(again).toEqual({ material: first.material, issued: false });

    const moved = ownCertificate(directory, ["autoheal.example.org", "localhost"], NOW);
    expect(moved.issued).toBe(true);
    expect(new X509Certificate(moved.material.certificate).checkHost("autoheal.example.org")).toBe(
      "autoheal.example.org",
    );
    const renewed = ownCertificate(directory, ["autoheal.example.org", "localhost"], NOW + 800 * MILLISECONDS_PER_DAY);
    expect(renewed.issued).toBe(true);
    expect([moved.material.pin, renewed.material.pin]).toEqual([first.material.pin, first.material.pin]);
    expect(readFileSync(join(directory, "certificate.pem"), "utf8")).toBe(renewed.material.certificate);
  });

  it.each(["[fd00::5]", "fd00::5", "FD00:0000:0000:0000:0000:0000:0000:0005"])(
    "includes IPv6 literal %s as a matching IP SAN",
    (name) => {
      const { material } = ownCertificate(directory, [name, "localhost"], NOW);
      const certificate = new X509Certificate(material.certificate);
      expect(certificate.checkIP("fd00::5")).toBeDefined();
      expect(certificate.checkIP("fd00::6")).toBeUndefined();
    },
  );

  it.each(["::", "::1", "2001:db8::", "2001:db8::1", "1:2:3:4:5:6:7:8", "[2001:DB8:0:1::ABCD]", "::ffff:192.0.2.128"])(
    "encodes every IPv6 word for %s as an IP address rather than a DNS name",
    (name) => {
      const { material } = ownCertificate(directory, [name], NOW);
      const certificate = new X509Certificate(material.certificate);
      const address = name.replace(/^\[|\]$/g, "");
      expect(certificate.checkIP(address)).toBeDefined();
      expect(certificate.checkIP("2001:db8::bad")).toBeUndefined();
      expect(certificate.subjectAltName).toMatch(/^IP Address:/);
      expect(certificate.subjectAltName).not.toContain("DNS:");
      expect(certificate.verify(certificate.publicKey)).toBe(true);
    },
  );

  it("adds a missing IPv6 SAN once, reuses equivalent spellings and preserves the key/pin across changes and expiry", () => {
    // The previous version served localhost alone when configured with an IPv6 public URL.
    const legacy = ownCertificate(directory, ["localhost"], NOW);
    const key = readFileSync(join(directory, "key.pem"), "utf8");
    const added = ownCertificate(directory, ["[fd00::5]", "localhost"], NOW);
    expect(added.issued).toBe(true);
    expect(new X509Certificate(added.material.certificate).checkIP("fd00::5")).toBeDefined();
    const same = ownCertificate(
      directory,
      ["localhost", "FD00:0000:0000:0000:0000:0000:0000:0005", "fd00::5", "[fd00::5]"],
      NOW + MILLISECONDS_PER_DAY,
    );
    expect(same).toEqual({ material: added.material, issued: false });
    expect(new X509Certificate(same.material.certificate).subjectAltName?.split(", ")).toHaveLength(2);
    const moved = ownCertificate(directory, ["localhost", "[fd00::6]"], NOW);
    expect(moved.issued).toBe(true);
    const renewed = ownCertificate(directory, ["FD00:0:0:0:0:0:0:6", "localhost"], NOW + 800 * MILLISECONDS_PER_DAY);
    expect(renewed.issued).toBe(true);
    const parsed = new X509Certificate(renewed.material.certificate);
    expect(parsed.checkIP("fd00::6")).toBeDefined();
    expect(parsed.checkIP("fd00::5")).toBeUndefined();
    for (const next of [added, same, moved, renewed]) {
      expect(next.material.key).toBe(key);
      expect(next.material.pin).toBe(legacy.material.pin);
    }
    expect(readFileSync(join(directory, "key.pem"), "utf8")).toBe(key);
    expect(statSync(join(directory, "key.pem")).mode & FILE_MODE_BITS).toBe(SECRET_FILE_MODE);
    const removed = ownCertificate(directory, ["localhost"], NOW);
    expect(removed.issued).toBe(true);
    expect(new X509Certificate(removed.material.certificate).checkIP("fd00::6")).toBeUndefined();
    expect(removed.material.pin).toBe(legacy.material.pin);
  });

  it("reuses IPv4-mapped IPv6 names regardless of dotted or hexadecimal spelling", () => {
    const first = ownCertificate(directory, ["::ffff:192.0.2.128", "192.0.2.128", "localhost"], NOW);
    const same = ownCertificate(directory, ["localhost", "[::FFFF:C000:0280]", "192.0.2.128"], NOW);
    expect(same).toEqual({ material: first.material, issued: false });
    const parsed = new X509Certificate(same.material.certificate);
    expect(parsed.checkIP("::ffff:192.0.2.128")).toBeDefined();
    expect(parsed.checkIP("192.0.2.128")).toBeDefined();
    expect(parsed.checkHost("localhost")).toBeDefined();
  });

  it("verifies the IPv6 identity in a real TLS handshake and rejects another address or untrusted certificate", async () => {
    const material = ownCertificate(directory, ["[fd00::5]"], Date.now()).material;
    const server = createServer({ key: material.key, cert: material.certificate });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    // Use IPv4 loopback transport so the fixture works without an IPv6 interface. X509.checkIP
    // verifies the intended IPv6 identity against the peer certificate; trust verification stays enabled.
    const verify = (identity: string, ca = material.certificate) =>
      new Promise<boolean>((resolve, reject) => {
        const socket = connect({
          host: "127.0.0.1",
          port,
          ca,
          rejectUnauthorized: true,
          checkServerIdentity: (_host, certificate) =>
            new X509Certificate(certificate.raw).checkIP(identity) !== undefined
              ? undefined
              : Object.assign(new Error("The TLS peer does not serve the expected IPv6 address"), {
                  code: "ERR_TLS_CERT_ALTNAME_INVALID",
                }),
        });
        socket.once("secureConnect", () => {
          socket.end();
          resolve(socket.authorized);
        });
        socket.once("error", (error) => {
          socket.destroy();
          reject(error);
        });
      });
    try {
      await expect(verify("fd00::5")).resolves.toBe(true);
      await expect(verify("fd00:0:0:0:0:0:0:5")).resolves.toBe(true);
      await expect(verify("fd00::6")).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
      const otherCA = readFileSync(join(import.meta.dirname, "../../../test/fixtures/tls/trusted-ca.pem"), "utf8");
      await expect(verify("fd00::5", otherCA)).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("is what a client sees in a real handshake, and so is an operator's own certificate", async () => {
    const own = ownCertificate(directory, NAMES, NOW).material;
    expect(await pinSeenByClient(own)).toBe(own.pin);
    const fixtures = join(import.meta.dirname, "../../../test/fixtures/tls");
    const provided = providedCertificate({
      certificateFile: join(fixtures, "server.pem"),
      keyFile: join(fixtures, "server-key.pem"),
    });
    expect(await pinSeenByClient(provided)).toBe(provided.pin);
  });
});
