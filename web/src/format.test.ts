import { describe, expect, it } from "vitest";
import { TEXT } from "./constants.js";
import { browserName } from "./format.js";

const CHROME_ON_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const FIREFOX_ON_ANDROID = "Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0";
const EDGE_ON_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const SAFARI_ON_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

describe("browserName", () => {
  it("names the browser and the system, past the names browsers borrow from each other", () => {
    expect(browserName(CHROME_ON_LINUX)).toBe("Chrome on Linux");
    expect(browserName(FIREFOX_ON_ANDROID)).toBe("Firefox on Android");
    expect(browserName(EDGE_ON_WINDOWS)).toBe("Edge on Windows");
    expect(browserName(SAFARI_ON_IPHONE)).toBe("Safari on iOS");
  });

  it("shows any other client as it calls itself", () => {
    expect(browserName("curl/8.5.0")).toBe("curl/8.5.0");
    expect(browserName(null)).toBe(TEXT.account.unknownBrowser);
  });
});
