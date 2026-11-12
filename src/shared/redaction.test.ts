import { describe, expect, it } from "vitest";
import { redactSecrets, redactYamlSecrets } from "./redaction.js";

describe("redactSecrets", () => {
  it("replaces the container's own environment values of 8+ characters with their name", () => {
    const environment = ["DB_PASSWORD=s3cr3t-value!", "LOG_LEVEL=info", "PORT=8080", "FEATURE=true", "EMPTY="];
    const text = "connecting with s3cr3t-value! on 8080 at info level, feature true";
    expect(redactSecrets(text, environment)).toBe(
      "connecting with [REDACTED:DB_PASSWORD] on 8080 at info level, feature true",
    );
  });

  it("prefers the longest value when one contains another", () => {
    const environment = ["SHORT=abcdefgh", "LONG=abcdefgh-ijklmnop"];
    expect(redactSecrets("x abcdefgh-ijklmnop y abcdefgh", environment)).toBe("x [REDACTED:LONG] y [REDACTED:SHORT]");
  });

  it("treats values with regex characters literally", () => {
    expect(redactSecrets("key is a.b*c+d?(e)", ["SECRET=a.b*c+d?(e)"])).toBe("key is [REDACTED:SECRET]");
  });

  it.each([
    ["password=hunter2-hunter2", "password=[REDACTED]"],
    ['{"db_password": "hunter2"}', '{"db_password": "[REDACTED]"}'],
    ["API_KEY: abc123def456", "API_KEY: [REDACTED]"],
    ["Authorization: Bearer eyAbCdEfGhIjKlMnOp", "Authorization: Bearer [REDACTED]"],
    ["postgres://paperless:topsecret@db:5432/paperless", "postgres://paperless:[REDACTED]@db:5432/paperless"],
    ["token gtfya.4JMEGPaNGyVnLmm9caxNGVFcXu", "token [REDACTED]"],
    ["key AKIAABCDEFGHIJKLMNOP used", "key [REDACTED] used"],
    ["OPENAI sk-abcdefghijklmnopqrstuvwxyz0123", "OPENAI [REDACTED]"],
    ["slack xoxb-123456789012-abcdefghijkl", "slack [REDACTED]"],
    ["telegram 123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", "telegram [REDACTED]"],
    ["https://discord.com/api/webhooks/123456/abcDEF_xyz-123 sent", "https://discord.com/api/webhooks/[REDACTED] sent"],
    ["password: 'hunter 2 hunter'", "password: '[REDACTED]'"],
    ["{'api_key': 'it''s secret', 'user': 'bob'}", "{'api_key': '[REDACTED]', 'user': 'bob'}"],
    ['secret="a \\"b\\" c" next', 'secret="[REDACTED]" next'],
    ["token: 'left open to the end", "token: '[REDACTED]'"],
  ])("masks %s", (text, expected) => {
    expect(redactSecrets(text)).toBe(expected);
  });

  it("masks private keys and JWTs", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----";
    expect(redactSecrets(`loaded ${key} ok`)).toBe("loaded [REDACTED PRIVATE KEY] ok");
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactSecrets(`session ${jwt}`)).toBe("session [REDACTED JWT]");
  });

  it("leaves ordinary log lines alone", () => {
    const line = "2026-10-20 12:00:01 ERROR connection refused to tika:9998 after 3 retries";
    expect(redactSecrets(line, ["TIKA_URL=http://tika:9998"])).toBe(line);
  });
});

describe("redactYamlSecrets", () => {
  it("masks a value named like a secret however YAML writes it, and leaves what is beside it", () => {
    const yaml = [
      "data:",
      "  password: plain words here",
      "  credentials:",
      "    user: nested",
      "",
      "    pass: nested too",
      "  note: kept",
      "list:",
      "  - token: >-",
      "      folded",
      "    kept: item sibling",
      "  - 'secret': \"wraps",
      '      on"',
      "other: {api_key: inline, name: kept}",
    ].join("\n");
    expect(redactYamlSecrets(yaml)).toBe(
      [
        "data:",
        "  password: [REDACTED]",
        "  credentials: [REDACTED]",
        "  note: kept",
        "list:",
        "  - token: [REDACTED]",
        "    kept: item sibling",
        "  - 'secret': [REDACTED]",
        "other: {api_key: [REDACTED], name: kept}",
      ].join("\n"),
    );
    expect(redactYamlSecrets("password: plain words\r\nnote: kept\r")).toBe("password: [REDACTED]\nnote: kept\r");
  });
});
