import type { Browser, Page } from "@playwright/test";

/** Shared only by the isolated real-browser acceptance fixtures. Never use production credentials. */
export interface FeatureUIContext {
  page: Page;
  browser: Browser;
  adminSecret: string;
  docker: (...args: string[]) => string;
  openHost: (label: string) => Promise<void>;
  freshCode: (secret: string) => Promise<string>;
  completeFirstSignIn: (
    page: Page,
    username: string,
    initialPassword: string,
    newPassword: string,
  ) => Promise<{ secret: string; passphrase: string | null }>;
}
