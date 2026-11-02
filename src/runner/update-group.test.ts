import { describe, expect, it } from "vitest";
import { UPDATE_GROUP_LABEL, updateGroupOf } from "./update-group.js";
import type { ContainerDetails } from "./incident-report.js";
const details = (text: string) =>
  ({
    Name: "/app",
    State: { Running: false },
    Config: { Image: "example:1", Labels: { [UPDATE_GROUP_LABEL]: text } },
  }) as ContainerDetails;
describe("retained update group manifest", () => {
  it("treats absent manifests as ordinary containers", () => {
    expect(updateGroupOf(null)).toBeNull();
  });
  it.each([
    "not json",
    "{}",
    JSON.stringify({
      version: 1,
      provider: { name: "app", id: "1", running: true },
      dependents: [{ name: "app", id: "1", running: false }],
    }),
  ])("refuses invalid or duplicate members", (text) => {
    expect(() => updateGroupOf(details(text))).toThrow();
  });
});
