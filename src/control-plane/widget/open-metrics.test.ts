import { describe, expect, it } from "vitest";
import { renderOpenMetrics } from "./open-metrics.js";

describe("OpenMetrics text", () => {
  it("writes each gauge's help, type and samples, escapes what OpenMetrics escapes, and ends as it must", () => {
    const text = renderOpenMetrics([
      {
        name: "autoheal_host_up",
        help: "Up, or not.\nA backslash: \\.",
        samples: [
          { labels: { host: 'Alder "lab"\\\n2' }, value: 1 },
          { labels: { host: "Delta" }, value: 0 },
        ],
      },
      { name: "autoheal_incidents_awaiting_approval", help: "Waiting.", samples: [{ labels: {}, value: 0.25 }] },
      // Neither a gauge without samples nor a value that is not a number is written.
      { name: "autoheal_host_load1", help: "Load.", samples: [] },
      { name: "autoheal_host_cpu_busy_ratio", help: "Busy.", samples: [{ labels: { host: "Delta" }, value: NaN }] },
    ]);
    expect(text).toBe(
      [
        "# HELP autoheal_host_up Up, or not.\\nA backslash: \\\\.",
        "# TYPE autoheal_host_up gauge",
        'autoheal_host_up{host="Alder \\"lab\\"\\\\\\n2"} 1',
        'autoheal_host_up{host="Delta"} 0',
        "# HELP autoheal_incidents_awaiting_approval Waiting.",
        "# TYPE autoheal_incidents_awaiting_approval gauge",
        "autoheal_incidents_awaiting_approval 0.25",
        "# EOF",
        "",
      ].join("\n"),
    );
  });

  it("says only that it ended when there is nothing to tell", () => {
    expect(renderOpenMetrics([])).toBe("# EOF\n");
  });
});
