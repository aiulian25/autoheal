import { describe, expect, it } from "vitest";
import type { ContainerSummary, DockerEvent } from "./docker-client.js";
import { EventStreamCheck } from "./event-stream-check.js";

const listed = (name: string, State: string, Status: string): ContainerSummary => ({
  Id: `${name}-id`,
  Names: [`/${name}`],
  State,
  Status,
});
const up = (name: string) => listed(name, "running", "Up 2 hours");
const exited = (name: string) => listed(name, "exited", "Exited (1) 5 seconds ago");
const unhealthy = (name: string) => listed(name, "running", "Up 2 hours (unhealthy)");
const restarting = (name: string) => listed(name, "restarting", "Restarting (1) 2 seconds ago");
const told = (name: string, Action: string): DockerEvent => ({
  Type: "container",
  Action,
  Actor: { Attributes: { name } },
});

describe("telling an event stream that fell silent from a quiet one", () => {
  it("finds nothing while nothing changes, or while the stream tells what does", () => {
    const check = new EventStreamCheck();
    expect(check.missed([up("paperless"), up("tika")])).toBeNull();
    expect(check.missed([up("paperless"), up("tika")])).toBeNull();
    check.note(told("paperless", "die"));
    check.note(told("tika", "health_status: unhealthy"));
    expect(check.missed([exited("paperless"), unhealthy("tika")])).toBeNull();
    expect(check.missed([exited("paperless"), unhealthy("tika")])).toBeNull();
  });

  it("names a container that went down untold, once two looks in a row find it so", () => {
    const check = new EventStreamCheck();
    check.missed([up("paperless")]);
    expect(check.missed([exited("paperless")])).toBeNull();
    expect(check.missed([exited("paperless")])).toBe("paperless");
  });

  it("names one that turned unhealthy untold", () => {
    const check = new EventStreamCheck();
    check.missed([up("tika")]);
    check.missed([unhealthy("tika")]);
    expect(check.missed([unhealthy("tika")])).toBe("tika");
  });

  it("waits for an event that a look came too soon for", () => {
    const check = new EventStreamCheck();
    check.missed([up("paperless")]);
    expect(check.missed([exited("paperless")])).toBeNull();
    check.note(told("paperless", "die"));
    expect(check.missed([exited("paperless")])).toBeNull();
  });

  it("names one that went down after the stream last said it started, or that it was unhealthy", () => {
    const started = new EventStreamCheck();
    started.missed([exited("paperless")]);
    started.note(told("paperless", "start"));
    started.missed([exited("paperless")]);
    expect(started.missed([exited("paperless")])).toBe("paperless");

    const sick = new EventStreamCheck();
    sick.missed([up("tika")]);
    sick.note(told("tika", "health_status: unhealthy"));
    sick.missed([exited("tika")]);
    expect(sick.missed([exited("tika")])).toBe("tika");
  });

  it("leaves alone what was down or unhealthy when it was first listed, and Docker starting one again", () => {
    const check = new EventStreamCheck();
    check.missed([exited("attic"), unhealthy("sick"), up("looping")]);
    check.note(told("looping", "die"));
    check.note(told("looping", "exec_die"));
    expect(check.missed([exited("attic"), unhealthy("sick"), restarting("looping")])).toBeNull();
    expect(check.missed([exited("attic"), unhealthy("sick"), restarting("looping")])).toBeNull();
  });

  it("takes a container listed again under a name that went away as new", () => {
    const check = new EventStreamCheck();
    check.missed([up("paperless")]);
    check.missed([]);
    check.missed([exited("paperless")]);
    expect(check.missed([exited("paperless")])).toBeNull();
  });
});
