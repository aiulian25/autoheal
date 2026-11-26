import type { Page } from "@playwright/test";

/** Shared only by the isolated real-browser acceptance fixtures. Never use production credentials. */
export interface FeatureUIContext {
  page: Page;
  adminSecret: string;
  docker: (...args: string[]) => string;
  openHost: (label: string) => Promise<void>;
}
