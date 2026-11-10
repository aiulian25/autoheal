import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAssistantLine } from "../src/control-plane/jarvis/assistant-line.js";
import { APP_VERSION } from "../src/shared/constants.js";
import { ASSISTANT_FILES, JARVIS_CODE_CHARACTERS, assistantFileLink, jarvisQuestion } from "../src/shared/jarvis.js";

// People import the blueprint and write their own automations from the page: both must say what Autoheal does.
describe("the assistant's blueprint and its contract page", () => {
  const blueprint = readFileSync(ASSISTANT_FILES.blueprint, "utf8");
  const page = readFileSync(ASSISTANT_FILES.contract, "utf8");

  it("uses every input its form asks for, and asks for every input it uses", () => {
    const inputs = blueprint.slice(blueprint.indexOf("\n  input:\n"), blueprint.indexOf("\nmode:"));
    const asked = [...inputs.matchAll(/^ {4}([a-z_]+):$/gm)].map(([, name]) => name);
    const used = [...blueprint.matchAll(/!input ([a-z_]+)/g)].map(([, name]) => name);
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(used)).toEqual(new Set(asked));
  });

  it("is imported from where the repository keeps it, by the link the page gives and the card's", () => {
    const source = /^ {2}source_url: (\S+)$/m.exec(blueprint)?.[1] ?? "";
    expect(source.endsWith(`/blob/main/${ASSISTANT_FILES.blueprint}`)).toBe(true);
    expect(page).toContain(`blueprint_url=${encodeURIComponent(source)}`);
    // The card's link is the same file, at the version that is running.
    expect(assistantFileLink(APP_VERSION, ASSISTANT_FILES.blueprint)).toBe(
      source.replace("/blob/main/", `/blob/v${APP_VERSION}/`),
    );
  });

  it("gives only lines Autoheal reads, and asks in Autoheal's own words", () => {
    const reads = page.slice(page.indexOf("### What Autoheal reads back"));
    const lines = [...reads.matchAll(/^autoheal .+$/gm)].map(([line]) =>
      line
        .replace("<id>", "0b6c1d2e-5f00-4c4b-9a6e-2d8e7f3a1b90")
        .replace("<code>", "c".repeat(JARVIS_CODE_CHARACTERS))
        .replace("<time>", "1794316452"),
    );
    expect(lines.map((line) => parseAssistantLine(line)?.verb)).toEqual(["heard", "later", "yes", "no"]);
    const example = JSON.parse(/```json\n([\s\S]+?)\n```/.exec(page)![1]!) as {
      host: string;
      names: string[];
      say: string;
      text: string;
      code: string;
    };
    // A new connection has no form of address: the page shows the words everyone starts with.
    expect(jarvisQuestion(example, false, null)).toEqual({ say: example.say, text: example.text });
    expect(example.code).toHaveLength(JARVIS_CODE_CHARACTERS);
  });
});
