import { useEffect, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { PATHS, SETTINGS_SECTIONS, TEXT } from "../constants.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { Tabs } from "./common.js";

interface Tab {
  path: string;
  label: string;
  adminOnly: boolean;
}

// The pages a menu section holds; the ones only admins may open are not offered to viewers.
function SectionTabs({ label, tabs }: { label: string; tabs: readonly Tab[] }) {
  const admin = isAdmin(useSignedInSession());
  return <Tabs label={label} items={tabs.filter((tab) => admin || !tab.adminOnly)} />;
}

const HISTORY: readonly Tab[] = [
  { path: PATHS.incidents, label: TEXT.history.incidents, adminOnly: false },
  { path: PATHS.audit, label: TEXT.history.audit, adminOnly: true },
];

const RULES: readonly Tab[] = [
  { path: PATHS.runbooks, label: TEXT.rules.runbooks, adminOnly: false },
  { path: PATHS.replays, label: TEXT.rules.replays, adminOnly: false },
];

export const HistoryTabs = () => <SectionTabs label={TEXT.history.label} tabs={HISTORY} />;
export const RulesTabs = () => <SectionTabs label={TEXT.rules.label} tabs={RULES} />;

/** A link from another page to one section of this one: scrolled to once the page has drawn it. */
export function useScrollToHash(ready: boolean) {
  const { hash } = useLocation();
  useEffect(() => {
    if (ready && hash !== "") {
      document.getElementById(hash.slice(1))?.scrollIntoView();
    }
  }, [ready, hash]);
}

export type SettingsSection = (typeof SETTINGS_SECTIONS)[keyof typeof SETTINGS_SECTIONS];

const SETTINGS_ITEMS: readonly { section: SettingsSection; adminOnly: boolean }[] = [
  { section: SETTINGS_SECTIONS.connections, adminOnly: false },
  { section: SETTINGS_SECTIONS.notifications, adminOnly: false },
  { section: SETTINGS_SECTIONS.schedules, adminOnly: false },
  { section: SETTINGS_SECTIONS.backups, adminOnly: true },
  { section: SETTINGS_SECTIONS.people, adminOnly: true },
  { section: SETTINGS_SECTIONS.system, adminOnly: false },
  { section: SETTINGS_SECTIONS.account, adminOnly: false },
];

const isSettingsSection = (hash: string): hash is SettingsSection =>
  SETTINGS_ITEMS.some(({ section }) => section === hash);

/**
 * The settings down the side: on the settings page each one jumps to its section; from the pages they
 * lead on to (people, backups, your account) each one goes back to it. Your account is a page of its own.
 */
export function SettingsNav({ current }: { current: SettingsSection | null }) {
  const admin = isAdmin(useSignedInSession());
  const hash = useLocation().hash.slice(1);
  const jumped = isSettingsSection(hash) ? hash : SETTINGS_SECTIONS.connections;
  // On Settings, the URL names the current section; subpages supply their own.
  const active = current ?? jumped;
  const onPage = current === null;
  return (
    <nav className="settings-nav" aria-label={TEXT.settingsPage.nav.label}>
      {SETTINGS_ITEMS.filter((item) => admin || !item.adminOnly).map(({ section }) => {
        const label = TEXT.settingsPage.nav[section];
        const marked = section === active ? "true" : undefined;
        if (section === SETTINGS_SECTIONS.account) {
          return (
            <Link key={section} to={PATHS.account} aria-current={marked}>
              {label}
            </Link>
          );
        }
        return onPage ? (
          <a key={section} href={`#${section}`} aria-current={marked}>
            {label}
          </a>
        ) : (
          <Link key={section} to={`${PATHS.settings}#${section}`} aria-current={marked}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** The settings area: its title, the sections down the side, and the page's own content beside them. */
export function SettingsFrame({ current, children }: { current: SettingsSection | null; children: ReactNode }) {
  return (
    <div className="page settings-page">
      <h1>{TEXT.settingsPage.title}</h1>
      <div className="settings-layout">
        <SettingsNav current={current} />
        <div className="settings-blocks">{children}</div>
      </div>
    </div>
  );
}

/** A page the settings lead on to, drawn like one of their sections: its title, what it holds, then the page. */
export function SettingsSubpage({
  current,
  title,
  lede,
  action,
  children,
}: {
  current: SettingsSection;
  title: string;
  lede: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SettingsFrame current={current}>
      <section className="settings-block" aria-label={title}>
        <header className="section-head">
          <h2>{title}</h2>
          {action}
        </header>
        {lede !== null && <p className="settings-lede">{lede}</p>}
        {children}
      </section>
    </SettingsFrame>
  );
}
