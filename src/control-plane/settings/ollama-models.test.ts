import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ERRORS } from "../../shared/api.js";
import type { AuditLog } from "../audit/audit-log.js";
import { OllamaSettingsService } from "./ollama-settings-service.js";
import type { SettingsStore } from "./settings-store.js";

const OTHER = "http://192.168.10.178:38271";
const service = () =>
  new OllamaSettingsService({ read: () => null } as unknown as SettingsStore, {} as AuditLog, {
    url: "http://192.168.10.123:11434",
    model: "a",
    contextTokens: 16_384,
  });

afterEach(() => vi.unstubAllGlobals());

describe("the models at an address", () => {
  it("asks that address, not the one in use, and says which are in memory", async () => {
    const fetch = vi.fn(async (url: string) =>
      Response.json(
        url.endsWith("/api/ps")
          ? { models: [{ name: "b:7b" }] }
          : {
              models: [
                { name: "a:4b", size: 5, details: { parameter_size: "4B", quantization_level: "Q4" } },
                { name: "b:7b", size: 9 },
              ],
            },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await service().modelsAt(OTHER)).toEqual([
      { name: "a:4b", sizeBytes: 5, parameterSize: "4B", quantization: "Q4", loaded: false },
      { name: "b:7b", sizeBytes: 9, parameterSize: null, quantization: null, loaded: true },
    ]);
    expect(fetch.mock.calls.every(([url]) => url.startsWith(OTHER))).toBe(true);
  });

  it("says when nothing answers there", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("refused");
      }),
    );
    await expect(service().modelsAt(OTHER)).rejects.toThrow(API_ERRORS.ollamaUnreachable);
  });
});
