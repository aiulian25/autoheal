import { describe, expect, it } from "vitest";
import { jarvisOutcome, jarvisReplies } from "../../shared/jarvis.js";
import { outcomeOf, refusalWords, sameCode } from "./assistant-answers.js";

describe("what a yes is told", () => {
  it("says what came of each update, the host named once", () => {
    const outcome = outcomeOf(["whoami", "gitea", "umami"], ["t1", "t2", "t3"], { t1: true, t2: false });
    expect(outcome).toEqual({ updated: ["whoami"], notUpdated: ["gitea"], notDone: ["umami"] });
    expect(jarvisOutcome("OrionBx3", outcome, "sir")).toEqual({
      say: "whoami on Orion B x three is updated, sir. gitea was not updated: the dashboard says why. umami is not done yet.",
      text: "OrionBx3: whoami is updated. gitea was not updated: the dashboard says why. umami is not done yet.",
    });
    const both = outcomeOf(["a", "b"], ["t1", "t2"], { t1: true, t2: true });
    expect(jarvisOutcome("Alder", both, "sir").say).toBe("a and b on Alder are updated, sir.");
    expect(jarvisOutcome("Alder", both, null).say).toBe("a and b on Alder are updated.");
  });

  it("says why a yes was not carried out, by the hand-over's refusal", () => {
    const sir = jarvisReplies("sir");
    expect(refusalWords("hands_off", "Alder", sir).say).toBe("Alder keeps my hands off that now, sir, so I left it.");
    expect(refusalWords("no_update", "Alder", sir).say).toBe("That update is gone, sir, so there is nothing to do.");
    expect(refusalWords("host_not_found", "Alder", sir).say).toBe(
      "I could not hand that over, sir. The dashboard says why.",
    );
    expect(refusalWords("no_update", "Alder", jarvisReplies(null)).say).toBe(
      "That update is gone, so there is nothing to do.",
    );
  });

  it("knows a code only as it was given", () => {
    expect(sameCode("Zk3vQ8mN2pL5tR7wX9yB1c", "Zk3vQ8mN2pL5tR7wX9yB1c")).toBe(true);
    expect(sameCode("Zk3vQ8mN2pL5tR7wX9yB1c", "Zk3vQ8mN2pL5tR7wX9yB1d")).toBe(false);
    expect(sameCode("Zk3vQ8mN2pL5tR7wX9yB1c", "short")).toBe(false);
    expect(sameCode(null, "Zk3vQ8mN2pL5tR7wX9yB1c")).toBe(false);
  });
});
