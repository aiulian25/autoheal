// Isolated image-level checkpoint validation. Build the image and server first; never mounts Docker's socket.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKPOINT, HOST_HELPER } from "../../dist/server/shared/constants.js";

const image = process.argv[2];
if (!image) throw new Error("Usage: node test/checkpoint/run-metadata.mjs <isolated-test-image>");
const root = mkdtempSync(join(tmpdir(), "autoheal-image-checkpoint-"));
const at = (...parts) => join(root, ...parts);
const py = (code, ...args) => execFileSync("python3", ["-c", code, ...args], { encoding: "utf8" }).trim();
const attrs = (path) =>
  JSON.parse(
    py(
      "import os,sys,json;print(json.dumps({k:os.getxattr(sys.argv[1],k).hex() for k in os.listxattr(sys.argv[1])}))",
      path,
    ),
  );
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
  ...CHECKPOINT.capabilities.flatMap((capability) => ["--cap-add", capability]),
  "--security-opt",
  HOST_HELPER.noNewPrivileges,
  "--security-opt",
  HOST_HELPER.noSelinuxLabel,
  "--memory",
  String(CHECKPOINT.memoryBytes),
  "--pids-limit",
  String(HOST_HELPER.pidsLimit),
];
const docker = (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
const report = (verb) => {
  const keep = verb === "keep";
  const mounts = [0, 1].flatMap((index) => [
    "--mount",
    `type=bind,src=${at(keep ? "live" : "kept", String(index))},dst=/from/${index},readonly`,
    "--mount",
    `type=bind,src=${at(keep ? "kept" : "live", String(index))},dst=/to/${index}`,
  ]);
  const output = docker([...flags, ...mounts, image, "volume-copy", verb, ...(keep ? ["1000000"] : [])]);
  const result = JSON.parse(output.trim().split("\n").at(-1));
  assert.equal(result.outcome, keep ? "kept" : "restored");
  assert.equal(result.fidelity, CHECKPOINT.fidelity);
};
try {
  mkdirSync(at("live", "0"), { recursive: true });
  mkdirSync(at("kept", "0"), { recursive: true });
  mkdirSync(at("kept", "1"));
  writeFileSync(at("live", "0", "one"), "original");
  linkSync(at("live", "0", "one"), at("live", "0", "two"));
  writeFileSync(at("live", "0", "separate"), "original");
  writeFileSync(at("live", "0", "owned"), "owned-original");
  writeFileSync(at("live", "1"), "single-original");
  chmodSync(at("live", "0"), 0o750);
  py("import os,sys;os.setxattr(sys.argv[1],'user.fixture',bytes([0,255,10]))", at("live", "0"));
  execFileSync("setfacl", ["-m", "u:12345:r-x,d:u:12345:r-x", at("live", "0")]);
  const originalRoot = attrs(at("live", "0"));
  docker([
    ...flags,
    "--mount",
    `type=bind,src=${root},dst=/fixture`,
    "--entrypoint",
    "/nodejs/bin/node",
    image,
    "-e",
    "const fs=require('node:fs');fs.chownSync('/fixture/live/0/owned',12345,12345);fs.chmodSync('/fixture/live/0/owned',0o640)",
  ]);
  const originalOwner = lstatSync(at("live", "0", "owned"));
  const fileInode = lstatSync(at("live", "1")).ino;
  report("keep");
  assert.deepEqual(attrs(at("kept", "0")), originalRoot);
  assert.equal(lstatSync(at("kept", "0", "owned")).uid, originalOwner.uid);
  assert.equal(lstatSync(at("kept", "0", "owned")).gid, originalOwner.gid);
  unlinkSync(at("live", "0", "two"));
  writeFileSync(at("live", "0", "two"), "migrated");
  unlinkSync(at("live", "0", "separate"));
  linkSync(at("live", "0", "one"), at("live", "0", "separate"));
  py("import os,sys;os.setxattr(sys.argv[1],'user.new',b'new')", at("live", "0"));
  execFileSync("setfacl", ["-k", at("live", "0")]);
  chmodSync(at("live", "0"), 0o700);
  writeFileSync(at("live", "1"), "single-migrated");
  report("restore");
  assert.equal(readFileSync(at("live", "0", "two"), "utf8"), "original");
  assert.equal(lstatSync(at("live", "0", "one")).ino, lstatSync(at("live", "0", "two")).ino);
  assert.notEqual(lstatSync(at("live", "0", "one")).ino, lstatSync(at("live", "0", "separate")).ino);
  assert.deepEqual(attrs(at("live", "0")), originalRoot);
  assert.equal(lstatSync(at("live", "0")).mode & 0o7777, 0o750);
  assert.equal(lstatSync(at("live", "0", "owned")).uid, originalOwner.uid);
  assert.equal(lstatSync(at("live", "0", "owned")).gid, originalOwner.gid);
  assert.equal(readFileSync(at("live", "1"), "utf8"), "single-original");
  assert.equal(lstatSync(at("live", "1")).ino, fileInode);
  console.log("Image checkpoint round trip passed with the unchanged helper capability/resource/network restrictions.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
