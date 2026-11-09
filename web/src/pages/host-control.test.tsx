import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type JobView } from "../../../src/shared/api.js";
import { HostControl } from "./host-control.js";
import { CONTROL, alder, controlView, serve, show, sent } from "../test-support/host-table.js";

// The terminal draws on a canvas jsdom lacks: in its place, what the row shows of it and its close button.
vi.mock("../components/shell-terminal.js", () => ({
  ContainerTerminal: ({ containerName, onClose }: { containerName: string; onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      {`Close the shell in ${containerName}`}
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("what Autoheal may do on a host", () => {
  it("says when the host only watches, and saves each answer at once", async () => {
    const fetch = serve({
      [CONTROL]: controlView(),
      [`PUT ${CONTROL}`]: controlView({ restartDefault: "restart" }),
    });
    show(<HostControl host={alder(true)} admin />);

    expect(await screen.findByText(/This host's .env keeps DRY_RUN on/)).toBeTruthy();
    const dies = screen.getByRole("radiogroup", { name: "When a container dies" });
    expect((within(dies).getByRole("radio", { name: /Ask me every time/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dies).getByRole("radio", { name: /Restart it, within the guard/ }));
    await sent(fetch, CONTROL, "PUT", { restartDefault: "restart" });
    expect(await screen.findByText("Saved")).toBeTruthy();

    // The two questions are apart: a safe new image can go in while a dying container waits for a person.
    const image = screen.getByRole("radiogroup", { name: "When a new image is out" });
    fireEvent.click(within(image).getByRole("radio", { name: /Apply it if Ollama calls it safe/ }));
    await sent(fetch, CONTROL, "PUT", { updateDefault: "apply" });

    // Or neither: only being told when one dies, and never updating.
    fireEvent.click(within(dies).getByRole("radio", { name: "Only tell me" }));
    await sent(fetch, CONTROL, "PUT", { restartDefault: "tell" });
    fireEvent.click(within(image).getByRole("radio", { name: "Never update" }));
    await sent(fetch, CONTROL, "PUT", { updateDefault: "never" });
  });

  it("says when unused images go next, and what went last", async () => {
    const last = { status: "succeeded", outcome: "Removed 3 images (24 MB).", createdAt: Date.now() } as JobView;
    const inTwoDays = Date.now() + 2 * 24 * 60 * 60 * 1000;
    serve({ [CONTROL]: controlView({ imageCleanup: "weekly", nextCleanupAt: inTwoDays, lastCleanup: last }) });
    show(<HostControl host={alder(false)} admin />);

    expect(await screen.findByText(/^Next run \w+day\. Images still in use are always kept\.$/)).toBeTruthy();
    expect(screen.getByLabelText(/Also clear Docker's build cache/)).toBeTruthy();
    expect(screen.getByText(/Removed 3 images \(24 MB\)\./)).toBeTruthy();
  });

  it("lets a viewer read it and change nothing", async () => {
    serve({ [CONTROL]: controlView() });
    show(<HostControl host={alder(false)} admin={false} />);

    expect(((await screen.findByLabelText(/How often/)) as HTMLSelectElement).disabled).toBe(true);
    for (const radio of screen.getAllByRole("radio")) {
      expect((radio as HTMLInputElement).disabled).toBe(true);
    }
  });
});
