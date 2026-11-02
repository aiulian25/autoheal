import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// People copy these from the README, so they must be what the repository really ships.
describe("what the README gives to copy", () => {
  const readme = readFileSync("README.md", "utf8");
  it.each(["docker-compose.yml", ".env.example"])("has %s as it is", (file) => {
    expect(readme).toContain(readFileSync(file, "utf8").trimEnd());
  });
  it("shows only screenshots that exist", () => {
    const paths = [...readme.matchAll(/\]\((docs\/screenshots\/[^)]+)\)/g)].map(([, path]) => path!);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(() => readFileSync(path)).not.toThrow();
  });
});
