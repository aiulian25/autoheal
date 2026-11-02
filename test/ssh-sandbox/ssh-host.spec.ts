import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import ssh2 from "ssh2";
import { CONTROL_PLANE_CONTAINER, E2E_LABEL, E2E_NETWORK } from "../e2e/global-setup.js";
import { sidewaysOverflow } from "../e2e/layout.js";
import { completeFirstSignIn } from "../e2e/sign-in.js";

// Neither may contain its username: the password policy refuses that.
const ADMIN_PASSWORD = "orbiting-tangerine-lantern-42";
// The machine Autoheal reaches over SSH, and the name the control plane dials it by on the sandbox's network.
const SSH_HOST = "autoheal-e2e-ssh-host";
const SSH_HOST_IMAGE = "autoheal-ssh-host:sandbox";
const SSH_ADDRESS = "ssh-host";
const SSH_USER = "sandbox";
const LABEL = "sandbox";
// A container on its Docker to open a shell in.
const TARGET = "autoheal-e2e-ssh-target";
const TARGET_IMAGE = "debian:13-slim";
const SLOW = 150_000;
const PHONE = { width: 375, height: 812 };
const SYSTEM_READY = /^(running|degraded)$/;
const HOST_KEY_FILE = "/etc/ssh/ssh_host_ed25519_key.pub";
// ssh2 is CommonJS: Node's ES module loader does not see `utils` among its named exports.
const { utils } = ssh2;

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const onHost = (input: string, ...command: string[]) =>
  execFileSync("docker", ["exec", "-i", SSH_HOST, ...command], { encoding: "utf8", input }).trim();
const dockerOrEmpty = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" }).stdout?.trim() ?? "";
const rail = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name });

/**
 * The SSH host, started as a person would set one up: systemd up, the user's own key authorized, the user in the group
 * of the engine's socket, and a password for sudo. Prints its host key's fingerprint, as the plan's script would.
 */
function startSshHost(publicLine: string, sudoPassword: string): string {
  docker(
    "run",
    "-d",
    "--name",
    SSH_HOST,
    "--label",
    E2E_LABEL,
    "--privileged",
    "--cgroupns",
    "private",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/run/lock",
    "--tmpfs",
    "/tmp",
    "--network",
    E2E_NETWORK,
    "--network-alias",
    SSH_ADDRESS,
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    SSH_HOST_IMAGE,
  );
  onHost(
    publicLine,
    "sh",
    "-c",
    `install -d -m 700 -o ${SSH_USER} -g ${SSH_USER} /home/${SSH_USER}/.ssh && cat > /home/${SSH_USER}/.ssh/authorized_keys && chown ${SSH_USER}: /home/${SSH_USER}/.ssh/authorized_keys && chmod 600 /home/${SSH_USER}/.ssh/authorized_keys`,
  );
  onHost(`${SSH_USER}:${sudoPassword}\n`, "chpasswd");
  // The socket's group by its number, as `usermod -aG docker` gives on a real machine.
  onHost(
    "",
    "sh",
    "-c",
    `gid=$(stat -c %g /var/run/docker.sock); group=$(getent group "$gid" | cut -d: -f1); if [ -z "$group" ]; then group=docker; groupadd -g "$gid" "$group"; fi; usermod -aG "$group" ${SSH_USER}`,
  );
  const fingerprint = onHost("", "ssh-keygen", "-lf", HOST_KEY_FILE).split(" ")[1]!;
  console.log(`SSH sandbox host: ${SSH_USER}@${SSH_ADDRESS}, host key ${fingerprint}`);
  return fingerprint;
}

test.describe.serial("a host over SSH, in the sandbox", () => {
  let page: Page;
  let fingerprint: string;
  const key = utils.generateKeyPairSync("ed25519", { comment: "autoheal-sandbox" });
  const sudoPassword = randomBytes(18).toString("base64url");

  test.beforeAll(async ({ browser }) => {
    docker("run", "-d", "--init", "--name", TARGET, "--label", E2E_LABEL, TARGET_IMAGE, "sleep", "86400");
    fingerprint = startSshHost(key.public, sudoPassword);
    await expect
      .poll(() => dockerOrEmpty("exec", SSH_HOST, "systemctl", "is-system-running"), { timeout: 60_000 })
      .toMatch(SYSTEM_READY);
    expect(dockerOrEmpty("exec", SSH_HOST, "systemctl", "is-active", "ssh")).toBe("active");
    page = await (await browser.newContext()).newPage();
    await completeFirstSignIn(page, "admin", process.env.E2E_ADMIN_PASSWORD!, ADMIN_PASSWORD);
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test("adds the host with the user's own key, after the host key is compared", async () => {
    await rail(page, "Fleet").click();
    const add = page.locator("section.add-host");
    await add.getByRole("textbox", { name: "Name" }).fill(LABEL);
    await add.getByRole("textbox", { name: "Address" }).fill(SSH_ADDRESS);
    await add.getByRole("textbox", { name: "User" }).fill(SSH_USER);
    await add.getByRole("button", { name: "Next" }).click();
    await add.getByRole("textbox", { name: "Private key" }).fill(key.private);
    await add.getByRole("button", { name: "Use this key" }).last().click();
    await add.getByRole("button", { name: "Connect" }).click();
    // The fingerprint offered is the one the host itself prints.
    await expect(add.getByText(fingerprint)).toBeVisible({ timeout: SLOW });
    await expect(add).toContainText("Docker is there");
    await add.getByRole("button", { name: "Trust and add" }).click();
    await expect(add).toContainText(`${LABEL} is added.`);

    await page.getByRole("article", { name: LABEL, exact: true }).click({ timeout: SLOW });
    await expect(page.getByRole("heading", { name: LABEL, exact: true, level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: "Over SSH" })).toContainText("connected over SSH", { timeout: SLOW });
    await page.getByRole("searchbox", { name: "Find" }).fill(TARGET);
    await expect(page.getByRole("button", { name: `Shell in ${TARGET}` })).toBeVisible({ timeout: SLOW });
  });

  test("saves the sudo password for root commands, and goes live with its own containers protected", async () => {
    const card = page.getByRole("region", { name: "Over SSH" });
    // The password first: it is checked over the host's session, which saving the settings starts again.
    await card.getByLabel("Root or sudo password").fill(sudoPassword);
    await card.getByRole("button", { name: "Check and save" }).click();
    await expect(card).toContainText("Saved: Autoheal runs root commands through sudo.", { timeout: SLOW });

    const settings = card.getByRole("form", { name: "Settings" });
    await settings
      .getByRole("textbox", { name: "Protected containers" })
      .fill(`${CONTROL_PLANE_CONTAINER} ${SSH_HOST}`);
    await settings.getByRole("checkbox", { name: /^Dry run/ }).uncheck();
    await settings.getByRole("combobox", { name: "Operating system packages" }).selectOption("apply");
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(settings.getByText("Saved")).toBeVisible();
  });

  test("opens a shell in one of its containers, over SSH, and types into it", async () => {
    await page.getByRole("searchbox", { name: "Find" }).fill(TARGET);
    const open = page.getByRole("button", { name: `Shell in ${TARGET}` });
    await expect(open).toBeEnabled({ timeout: SLOW });
    await open.click();
    const shell = page.getByRole("region", { name: `Shell in ${TARGET}` });
    await expect(shell.getByRole("status")).toHaveText("Connected", { timeout: SLOW });
    await shell.locator(".terminal-screen").click();
    await page.keyboard.type("echo autoheal-$((6 * 7)) > /tmp/proof\n");
    await expect.poll(() => dockerOrEmpty("exec", TARGET, "cat", "/tmp/proof"), { timeout: SLOW }).toBe("autoheal-42");
    await page.keyboard.type("exit 3\n");
    await expect(shell.getByRole("status")).toHaveText("The shell ended with exit code 3.", { timeout: SLOW });
    await shell.getByRole("button", { name: "Close" }).click();
  });

  test("checks its packages as root over SSH, and installs the security fix", async () => {
    const card = page.getByRole("region", { name: "Host packages" });
    const security = card.locator("li", { has: page.getByRole("button", { name: "autoheal-security", exact: true }) });
    await expect(security).toBeVisible({ timeout: SLOW });
    await expect(security).toContainText("security");
    // Only the security fix: the others are not this test's to apply.
    for (const tick of await card.getByRole("checkbox").all()) {
      await tick.setChecked((await tick.getAttribute("aria-label")) === "Select autoheal-security");
    }
    await card.getByRole("button", { name: "Install now" }).click();
    const terminal = card.getByRole("group", { name: "What the host is doing" });
    await expect(terminal).toContainText(".. install complete Upgraded autoheal-security.", { timeout: SLOW });
    expect(docker("exec", SSH_HOST, "dpkg-query", "-W", "-f", "${Version}", "autoheal-security")).toBe("1.1");
    // Run by the host's systemd, as on a runner host, not by Autoheal's image.
    expect(dockerOrEmpty("exec", SSH_HOST, "journalctl", "-u", "autoheal-packages.service", "--no-pager")).toContain(
      "autoheal-packages.service",
    );
  });
  // Last, so that a page too wide holds none of the checks above back.
  test("fits a phone's width once its containers are listed: nothing scrolls sideways", async () => {
    await page.setViewportSize(PHONE);
    await page.reload();
    await expect(page.getByRole("heading", { name: LABEL, exact: true, level: 1 })).toBeVisible();
    await expect(page.getByText(TARGET, { exact: true }).first()).toBeVisible({ timeout: SLOW });
    const { overflow, past } = await sidewaysOverflow(page);
    expect(overflow, past.join(", ")).toBeLessThanOrEqual(0);
  });
});
