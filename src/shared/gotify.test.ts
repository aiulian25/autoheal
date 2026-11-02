import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGotify } from "../../test/fakes/fake-gotify.js";
import { postToGotify } from "./gotify.js";

describe("postToGotify", () => {
  let gotify: FakeGotify;

  beforeEach(async () => {
    gotify = await FakeGotify.start();
  });

  afterEach(() => gotify.close());

  it("sends the title, a capped message and the priority with the app token", async () => {
    await postToGotify(gotify.settings, "Autoheal HP: paperless needs you", "x".repeat(5_000), 8);
    expect(gotify.messages).toHaveLength(1);
    expect(gotify.messages[0]).toMatchObject({
      title: "Autoheal HP: paperless needs you",
      priority: 8,
      key: "app-token",
    });
    expect(gotify.messages[0]!.message).toHaveLength(3_000);
  });

  it("never throws, even when Gotify fails or is unreachable", async () => {
    gotify.status = 500;
    await expect(postToGotify(gotify.settings, "t", "b", 5)).resolves.toBeUndefined();
    await expect(postToGotify({ url: "https://localhost:1", token: "x" }, "t", "b", 5)).resolves.toBeUndefined();
  });
});
