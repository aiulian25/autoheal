import { ContainerBackupSettings } from "./container-backup-settings.js";
import { NotificationRoutingEditor } from "../components/notification-deliveries.js";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { INTEGRATION_KIND } from "../../../src/shared/constants.js";
import { JarvisCard } from "./jarvis-card.js";
import { RouterCard } from "./router-card.js";
import { ErrorNotice, Loading } from "../components/common.js";
import { RegistryCredentialsCard } from "../components/registry-credentials.js";
import { ImageTrustCard } from "../components/image-trust.js";
import { SettingsFrame, useScrollToHash, type SettingsSection } from "../components/section-tabs.js";
import { SETTINGS_SECTIONS, TEXT } from "../constants.js";
import { integrationsQuery, settingsQuery } from "../queries.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { SshKeysCard } from "./ssh-keys-card.js";
import { OllamaCard } from "./settings/ollama-card.js";
import { HomeAssistantCard, isChannel, ChannelRow } from "./settings/integration-cards.js";
import { PackageWindowCard } from "./settings/package-window-card.js";
import { AlwaysRunningCard } from "./settings/always-running-card.js";
import { BackupSummary } from "./settings/backup-summary.js";
import { DataCard } from "./settings/data-card.js";
import { PeopleSummary } from "./settings/people-summary.js";
import { WidgetKeysCard } from "./settings/widget-keys-card.js";
import { SystemFacts } from "./settings/system-facts.js";
import { SelfUpdateCard } from "./settings/self-update-card.js";
import { TrustedProxiesCard } from "./settings/trusted-proxies-card.js";

const text = TEXT.settingsPage;

function SettingsBlock({
  section,
  children,
}: {
  section: Exclude<SettingsSection, typeof SETTINGS_SECTIONS.account>;
  children: ReactNode;
}) {
  const { title, lede } = text.sections[section];
  return (
    <section id={section} className="settings-block" aria-labelledby={`${section}-title`}>
      <h2 id={`${section}-title`}>{title}</h2>
      <p className="settings-lede">{lede}</p>
      {children}
    </section>
  );
}

/** Everything Autoheal is set up with, one section under the other, the sections down the side. */
export function SettingsPage() {
  const admin = isAdmin(useSignedInSession());
  const settings = useQuery(settingsQuery);
  const integrations = useQuery(integrationsQuery);
  useScrollToHash(settings.data !== undefined && integrations.data !== undefined);
  const view = settings.data;
  const homeAssistant = integrations.data?.find((integration) => integration.kind === INTEGRATION_KIND.homeAssistant);
  return (
    <SettingsFrame current={null}>
      {view === undefined && (settings.error ? <ErrorNotice error={settings.error} /> : <Loading />)}
      {view !== undefined && (
        <>
          {admin && view.invalidSettings !== undefined && view.invalidSettings.length > 0 && (
            <p className="notice warning" role="status">
              {text.invalidSettings(view.invalidSettings.map((key) => text.settingNames[key]).join(TEXT.listComma))}
            </p>
          )}
          <SettingsBlock section={SETTINGS_SECTIONS.connections}>
            <OllamaCard admin={admin} />
            {homeAssistant !== undefined && <HomeAssistantCard view={homeAssistant} admin={admin} />}
            {admin && <RegistryCredentialsCard />}
            {admin && <ImageTrustCard />}
            {admin && <RouterCard />}
            {admin && <JarvisCard />}
          </SettingsBlock>
          <SettingsBlock section={SETTINGS_SECTIONS.notifications}>
            <NotificationRoutingEditor admin={admin} />
            <ul className="card channels">
              {integrations.data?.filter(isChannel).map((channel) => (
                <ChannelRow key={channel.kind} view={channel} admin={admin} />
              ))}
            </ul>
            <ErrorNotice error={integrations.error} />
          </SettingsBlock>
          <SettingsBlock section={SETTINGS_SECTIONS.schedules}>
            <PackageWindowCard admin={admin} />
            <AlwaysRunningCard />
          </SettingsBlock>
          {admin && (
            <SettingsBlock section={SETTINGS_SECTIONS.backups}>
              <BackupSummary settings={view} />
              <ContainerBackupSettings />
              <DataCard />
            </SettingsBlock>
          )}
          {admin && (
            <SettingsBlock section={SETTINGS_SECTIONS.people}>
              <PeopleSummary />
              <WidgetKeysCard publicBaseUrl={view.publicBaseUrl} />
              <SshKeysCard dashboardAddress={new URL(view.runnerAddress).hostname} />
            </SettingsBlock>
          )}
          <SettingsBlock section={SETTINGS_SECTIONS.system}>
            <SystemFacts settings={view} />
            {admin && <SelfUpdateCard />}
            {admin && <TrustedProxiesCard view={view.trustedProxies} />}
          </SettingsBlock>
        </>
      )}
    </SettingsFrame>
  );
}
