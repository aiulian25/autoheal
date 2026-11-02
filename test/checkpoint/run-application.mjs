// Disposable mount fixtures only. The helper has no network, Docker socket or additional capabilities.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, linkSync, lstatSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
const image = process.argv[2];
if (!image) throw Error("Usage: node test/checkpoint/run-application.mjs <isolated-image>");
const root = mkdtempSync(join(tmpdir(), "autoheal-application-image-"));
const at = (...p) => join(root, ...p);
const identity = await generateX25519Identity(),
  recipient = await identityToRecipient(identity);
const flags = [
  "run",
  "--rm",
  "--network",
  "none",
  "--read-only",
  "--user",
  "0",
  "--cap-drop",
  "ALL",
  ...["CHOWN", "DAC_OVERRIDE", "DAC_READ_SEARCH", "FOWNER"].flatMap((cap) => ["--cap-add", cap]),
  "--security-opt",
  "no-new-privileges:true",
  "--security-opt",
  "label=disable",
  "--memory",
  "134217728",
  "--pids-limit",
  "32",
  "--tmpfs",
  "/work:rw,nosuid,nodev,noexec,size=73400320,mode=0700",
];
function copy(mode, from, artifact, input) {
  const mounts = [0, 1].flatMap((i) => [
    "--mount",
    `type=bind,src=${at(from, String(i))},dst=/application/${i}${mode === "capture" ? ",readonly" : ""}`,
  ]);
  const args = [
    ...flags,
    ...(input ? ["-i"] : []),
    ...mounts,
    "--mount",
    `type=bind,src=${at(artifact)},dst=/artifact${mode === "capture" ? "" : ",readonly"}`,
    image,
    "application-copy",
    mode,
    "2",
    ...(mode === "capture" ? [recipient, "f".repeat(64)] : ["f".repeat(64)]),
  ];
  const text = execFileSync("docker", args, {
    input: input ? JSON.stringify(input) : undefined,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 1048576,
  });
  const report = JSON.parse(text.trim());
  assert.equal(report.ok, true);
  if (mode === "capture")
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--user",
        "0",
        "--cap-drop",
        "ALL",
        "--mount",
        `type=bind,src=${at(artifact)},dst=/artifact`,
        "--entrypoint",
        "/nodejs/bin/node",
        image,
        "-e",
        "require('node:fs').chmodSync('/artifact/payload.age',0o644)",
      ],
      { timeout: 30000 },
    );
  return report;
}
try {
  for (const name of ["live", "clone", "large", "large-clone"])
    for (const i of [0, 1]) mkdirSync(at(name, String(i)), { recursive: true });
  for (const name of ["artifact", "large-artifact"]) mkdirSync(at(name));
  const db = new Database(at("live", "0", "app.sqlite"));
  db.exec("CREATE TABLE fixture(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO fixture VALUES(1,'original')");
  db.close();
  const original = readFileSync(at("live", "0", "app.sqlite"));
  writeFileSync(at("live", "1", "private"), "synthetic-shared-data");
  linkSync(at("live", "1", "private"), at("live", "1", "linked"));
  chmodSync(at("live", "1"), 0o750);
  execFileSync("python3", [
    "-c",
    "import os,sys;os.setxattr(sys.argv[1],'user.fixture',b'preserved')",
    at("live", "1"),
  ]);
  execFileSync("setfacl", ["-m", "u:12345:r-x", at("live", "1")]);
  const captured = copy("capture", "live", "artifact");
  const cipher = readFileSync(at("artifact", "payload.age"));
  assert.equal(cipher.includes(Buffer.from("synthetic-shared-data")), false);
  assert.equal(cipher.includes(Buffer.from("rsync-readable-posix")), false);
  const drilled = copy("drill", "clone", "artifact", {
    identity,
    sqlite: { mountTarget: "/data", path: "app.sqlite" },
    index: 0,
  });
  assert.equal(drilled.integrity, "sqlite-integrity-ok");
  assert.deepEqual(readFileSync(at("live", "0", "app.sqlite")), original);
  assert.deepEqual(readFileSync(at("clone", "0", "app.sqlite")), original);
  assert.equal(lstatSync(at("clone", "1", "private")).ino, lstatSync(at("clone", "1", "linked")).ino);
  assert.equal(lstatSync(at("clone", "1")).mode & 0o777, 0o750);
  const attributes = (path) =>
    execFileSync(
      "python3",
      [
        "-c",
        "import os,sys;print(sorted((n,os.getxattr(sys.argv[1],n).hex())for n in os.listxattr(sys.argv[1])))",
        path,
      ],
      { encoding: "utf8" },
    );
  assert.equal(attributes(at("clone", "1")), attributes(at("live", "1")));
  // Near-quota regular data exercises actual encrypted stream and bounded tmpfs under 128 MiB.
  writeFileSync(at("large", "0", "near-limit"), Buffer.alloc(31 * 1024 * 1024, 65));
  writeFileSync(at("large", "1", "small"), "second mount");
  const large = copy("capture", "large", "large-artifact");
  assert.ok(large.payloadBytes < 34 * 1024 * 1024);
  copy("drill", "large-clone", "large-artifact", { identity, sqlite: null, index: -1 });
  assert.equal(lstatSync(at("large-clone", "0", "near-limit")).size, 31 * 1024 * 1024);
  console.log(
    JSON.stringify({
      captured,
      drilled,
      nearQuotaBytes: large.payloadBytes,
      originalUnchanged: true,
      rootAclXattrAndHardLinks: true,
      helperMemoryBytes: 134217728,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
