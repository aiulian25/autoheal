import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { SECRET_FILE_MODE } from "../../shared/constants.js";
import { ensureBackupPassphrase, readBackupPassphrase } from "./backup-passphrase.js";

const FILE_MODE_BITS = 0o777;
const FROM_ENVIRONMENT = "correct-horse-battery-staple-0123456789";

describe("the backup passphrase", () => {
  let dataDirectory: string;

  beforeEach(() => {
    dataDirectory = mkdtempSync(join(tmpdir(), "autoheal-passphrase-"));
  });

  afterEach(() => {
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  it("is made on the first start, readable by Autoheal only, and kept", () => {
    expect(readBackupPassphrase({ dataDirectory, backupPassphrase: null })).toBeNull();
    const made = ensureBackupPassphrase({ dataDirectory, backupPassphrase: null });
    expect(made).toMatchObject({ generated: true, madeNow: true });
    expect(made.passphrase).toMatch(/^[A-Za-z0-9_-]{44}$/);
    expect(statSync(join(dataDirectory, "backup-passphrase")).mode & FILE_MODE_BITS).toBe(SECRET_FILE_MODE);
    expect(ensureBackupPassphrase({ dataDirectory, backupPassphrase: null })).toEqual({ ...made, madeNow: false });
  });

  it("is the .env's when it sets one, and then nothing is made", () => {
    expect(ensureBackupPassphrase({ dataDirectory, backupPassphrase: FROM_ENVIRONMENT })).toEqual({
      passphrase: FROM_ENVIRONMENT,
      generated: false,
      madeNow: false,
    });
    expect(readBackupPassphrase({ dataDirectory, backupPassphrase: null })).toBeNull();
  });

  it("is shown to the first admin who finishes setting up, next to the recovery codes, and never again", async () => {
    const controlPlane = await startTestControlPlane({ generatedBackupPassphrase: FROM_ENVIRONMENT });
    const first = await fullySignedInAdmin(controlPlane);
    expect(first.backupPassphrase).toBe(FROM_ENVIRONMENT);
    expect(first.recoveryCodes).toHaveLength(10);
    await fullySignedInUser(controlPlane, first.client, "second-admin", "admin");
    expect(controlPlane.services.backupPassphraseNotice.takeFor("admin")).toBeNull();
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });
});
