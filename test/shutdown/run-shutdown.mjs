// Run after npm run build. Uses real signals and temporary synthetic journal files, never Docker.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shutdownUrl = new URL("../../dist/server/shared/shutdown.js", import.meta.url).href;
const journalUrl = new URL("../../dist/server/runner/shutdown-journal.js", import.meta.url).href;
const phases = ["pull", "stop", "create", "start", "runCommand", "restore"];
for (const phase of phases) {
  for (const mode of ["drain", "timeout"]) {
    const directory = mkdtempSync(join(tmpdir(), "autoheal-shutdown-signal-"));
    const method = phase === "restore" ? "runCommand" : phase;
    const source = `
      import { untilShutdown } from ${JSON.stringify(shutdownUrl)};
      import { ShutdownJournal } from ${JSON.stringify(journalUrl)};
      import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
      const directory = ${JSON.stringify(directory)};
      const store = {
        volumes: async () => readdirSync(directory).map(name => JSON.parse(readFileSync(directory + '/' + name, 'utf8'))),
        createVolume: async (Name, Labels) => writeFileSync(directory + '/' + Name, JSON.stringify({ Name, Labels })),
        removeVolume: async name => unlinkSync(directory + '/' + name),
      };
      const journal = new ShutdownJournal(store);
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      let entered;
      const started = new Promise(resolve => { entered = resolve; });
      const docker = journal.docker({ [${JSON.stringify(method)}]: async () => { entered(); await gate; } });
      const work = journal.run('signal-fixture:${phase}', 'synthetic-app', () => docker[${JSON.stringify(method)}]('synthetic-original-id'));
      let calls = 0;
      const stop = untilShutdown(async () => {
        calls++;
        if (${JSON.stringify(mode)} === 'drain') setTimeout(release, 30);
        await work;
      }, 150);
      await started;
      setInterval(() => {}, 1000); // An open daemon socket/work loop keeps the child alive.
      console.log('READY');
      const code = await stop;
      console.log('RESULT ' + JSON.stringify({ code, calls }));
      process.exit(code);
    `;
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let signalled = false;
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Child exceeded signal test deadline."));
        }, 3000);
        child.stdout.on("data", (data) => {
          stdout += data.toString();
          if (!signalled && stdout.includes("READY")) {
            signalled = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGINT"), 5);
          }
        });
        child.stderr.on("data", (data) => {
          stderr += data.toString();
        });
        child.once("error", reject);
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, stdout, stderr });
        });
      });
      assert.equal(result.code, mode === "drain" ? 0 : 1, JSON.stringify(result));
      assert.equal(result.signal, null);
      assert.ok(result.stdout.includes('"calls":1'), result.stdout);
      const records = readdirSync(directory).map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
      if (mode === "drain") assert.deepEqual(records, []);
      else {
        const latest = records
          .map((volume) => JSON.parse(volume.Labels["autoheal.shutdown.record"]))
          .sort((a, b) => b.step - a.step)[0];
        assert.equal(latest.phase, method);
        assert.equal(latest.reference, "synthetic-original-id");
        assert.equal(latest.operation, `signal-fixture:${phase}`);
      }
      console.log(`${phase}: ${mode} passed (SIGTERM + SIGINT, exit ${result.code})`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
console.log("12 isolated process signal cases passed.");
