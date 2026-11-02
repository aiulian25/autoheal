import { describe, expect, it } from "vitest";
import {
  firstServiceOf,
  issuesOfComposeError,
  lineOfPath,
  lintOwnFiles,
  misplacedLine,
  projectNameOf,
  withFix,
} from "./compose-lint.js";

const FILE = `services:
  wiki:
    image: a:1
    ports:
      - "3000:3000"
    environment:
      DB_PASS: \${DB_PASSWORD}
      POSTGRES_PASSWORD: hunter2
      OPTIONAL: \${MAYBE:-x}
      ESCAPED: $$NOT_A_VARIABLE
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/data
`;

describe("what the files alone can tell", () => {
  it("finds a variable with no value, at its line, offering a place in the .env", () => {
    const [issue] = lintOwnFiles(FILE, "").filter(({ level }) => level === "error");
    expect(issue).toMatchObject({ line: 7, fix: { env: [{ name: "DB_PASSWORD", value: null }] } });
  });

  it("takes a value that is present, even blank, and one with a default", () => {
    expect(lintOwnFiles(FILE, "DB_PASSWORD=\n").filter(({ level }) => level === "error")).toEqual([]);
  });

  it("tells of a password in the file, and moves it", () => {
    const issue = lintOwnFiles(FILE, "DB_PASSWORD=x\n").find(({ line }) => line === 8)!;
    expect(issue.level).toBe("warning");
    const fixed = withFix({ compose: FILE, env: "DB_PASSWORD=x\n" }, issue.fix!, () => "made");
    expect(fixed.compose).toContain("      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}\n");
    expect(fixed.compose).not.toContain("hunter2");
    expect(fixed.env).toBe("DB_PASSWORD=x\nPOSTGRES_PASSWORD=hunter2\n");
  });

  it("tells of the Docker socket without stopping anything", () => {
    expect(lintOwnFiles(FILE, "DB_PASSWORD=x\n").find(({ line }) => line === 12)?.level).toBe("warning");
  });

  it("flags a setting nothing uses, and sees a misspelling for what it is", () => {
    const issues = lintOwnFiles(FILE, "DB_PASSWRD=x\n");
    const unused = issues.find(({ file }) => file === "env")!;
    expect(unused.fix?.label).toContain("DB_PASSWORD");
    const fixed = withFix({ compose: FILE, env: "DB_PASSWRD=x\n" }, unused.fix!, () => "made");
    expect(fixed.env).toBe("DB_PASSWORD=x\n");
    expect(lintOwnFiles(FILE, "UNRELATED=1\nDB_PASSWORD=x\n").find(({ file }) => file === "env")?.level).toBe(
      "warning",
    );
  });

  it("counts every setting as used when the service reads the .env whole", () => {
    const file = "services:\n  a:\n    image: b\n    env_file: .env\n";
    expect(lintOwnFiles(file, "ANYTHING=1\n")).toEqual([]);
  });

  it("makes up a password for a secret, and leaves anything else blank", () => {
    const fix = {
      label: "",
      lines: [],
      env: [
        { name: "API_TOKEN", value: null },
        { name: "COLOUR", value: null },
      ],
    };
    expect(withFix({ compose: "", env: "" }, fix, () => "made").env).toBe("API_TOKEN=made\nCOLOUR=\n");
  });
});

describe("a line in the wrong place", () => {
  const compose = (...lines: string[]) => `services:\n  wiki:\n    image: a\n${lines.join("\n")}\n`;

  it("sees a key that lines up with nothing", () => {
    const issue = misplacedLine(compose("    depends_on:", "      - db", "   db:", "    image: b"))!;
    expect(issue.line).toBe(6);
    expect(issue.message).toContain("wiki");
    expect(issue.fix?.lines[0]?.text).toBe("  db:");
  });

  it("lines a key between two levels up with the one its own lines say", () => {
    const issue = misplacedLine(compose("   ports:", '      - "1:1"'))!;
    expect(issue.message).toContain("image");
    expect(issue.fix?.lines[0]?.text).toBe("    ports:");
  });

  it("sees a key too far in under a value", () => {
    const issue = misplacedLine(compose("      ports: 3"))!;
    expect(issue.line).toBe(4);
    expect(issue.fix?.lines[0]?.text).toBe("    ports: 3");
  });

  it("sees a tab, and a missing colon", () => {
    expect(misplacedLine("services:\n  wiki:\n\timage: a\n")?.fix?.lines[0]?.text).toBe("  image: a");
    const noColon = misplacedLine("services:\n  wiki\n    image: a\n")!;
    expect(noColon.line).toBe(2);
    expect(noColon.fix?.lines[0]?.text).toBe("  wiki:");
  });

  it("leaves a right file alone, block text and same-indent lists included", () => {
    const file = `services:
  wiki:
    image: a
    command: |
      run this
         and this
    ports:
    - "1:1"
    - "2:2"
    labels:
      a: b
`;
    expect(misplacedLine(file)).toBeNull();
    expect(misplacedLine(FILE)).toBeNull();
  });
});

describe("what Compose said", () => {
  const issue = (output: string, file = FILE) => issuesOfComposeError(output, file)[0]!;

  it("takes either form of a YAML error's line", () => {
    const file = 'services:\n  wiki:\n    image: "a\n    ports: 1\n';
    const newer =
      "failed to parse x: go-yaml load error in scanner (while scanning a quoted scalar) at L3.C12-L5.C1: found";
    expect(issue(newer, file).line).toBe(5);
    expect(issue("yaml: line 3: found unexpected end of stream", file).line).toBe(3);
  });

  it("prefers the line it can see is wrong to the one a parser gave up on", () => {
    const file = "services:\n  wiki:\n    image: a\n   db:\n    image: b\n";
    const said = "failed to parse x: go-yaml load error in parser at L2.C3-L9.C4: did not find expected key";
    expect(issue(said, file)).toMatchObject({ line: 4, fix: { lines: [{ text: "  db:" }] } });
  });

  it("finds the line of a setting Compose does not know", () => {
    const file = "services:\n  wiki:\n    imag: a\n";
    const found = issue("validating x/docker-compose.yml: services.wiki.imag false schema", file);
    expect(found.line).toBe(3);
    expect(found.message).toContain("imag");
  });

  it("names the service that needs an image, or waits for one that is not there", () => {
    const file = "services:\n  wiki:\n    restart: always\n    depends_on:\n      - db\n";
    expect(issue('service "wiki" has neither an image nor a build context specified: invalid', file).line).toBe(2);
    expect(issue('service "wiki" depends on undefined service "db": invalid compose project', file).line).toBe(4);
  });

  it("points a .env problem at the .env", () => {
    expect(issue("failed to read /x/.env: line 3: key cannot contain a space")).toMatchObject({ file: "env", line: 3 });
  });

  it("says Compose's own words when it knows no better, without its warnings", () => {
    const said = 'time="x" level=warning msg="obsolete"\nsomething unusual';
    expect(issue(said).message).toBe("Compose says: something unusual");
  });

  it("finds a path's line", () => {
    expect(lineOfPath(FILE, "services.wiki.ports.0")).toBe(5);
    expect(lineOfPath(FILE, "services.wiki.volumes.1")).toBe(13);
    expect(lineOfPath(FILE, "services.other")).toBe(1);
  });
});

describe("names", () => {
  it("uses Compose's own rule for a folder's project name", () => {
    expect(projectNameOf("/srv/My.App_1")).toBe("myapp_1");
  });

  it("calls an app by its first service", () => {
    expect(firstServiceOf(FILE)).toBe("wiki");
    expect(firstServiceOf("version: 3\n")).toBeNull();
  });
});
