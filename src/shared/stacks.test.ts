import { describe, expect, it } from "vitest";
import { composeBuilds, envFilesNamedIn } from "./stacks.js";

describe("what a Compose file says", () => {
  it("finds its settings files in each way of writing them, keeping only those beside it", () => {
    const text = `services:
  a:
    env_file: .env
  b:
    env_file:
      - ./app.env
      - path: other.env
        required: false
      - /etc/secret.env
      - ../up.env
      - \${HOME}/x.env
    image: x
  c:
    env_file: "quoted.env"
`;
    expect(envFilesNamedIn(text)).toEqual([".env", "app.env", "other.env", "quoted.env"]);
  });

  it("knows one that builds on the host", () => {
    expect(composeBuilds("services:\n  a:\n    build: .\n")).toBe(true);
    expect(composeBuilds("services:\n  a:\n    image: rebuild:1\n")).toBe(false);
  });
});
