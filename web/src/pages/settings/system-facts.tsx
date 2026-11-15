import { type SettingsView } from "../../../../src/shared/api.js";
import { TEXT } from "../../constants.js";

const text = TEXT.settingsPage;

// --- System ------------------------------------------------------------------------------------------

export function SystemFacts({ settings }: { settings: SettingsView }) {
  const facts = text.systemFacts;
  // Only an admin is told which proxies are trusted.
  const proxies = settings.trustedProxies;
  const rows: { label: string; value: string; mono: boolean }[] = [
    { label: facts.version, value: settings.version, mono: true },
    { label: facts.address, value: settings.publicBaseUrl, mono: true },
    { label: facts.certificate, value: TEXT.settings.madeBy.certificate[settings.certificate], mono: false },
    ...(proxies === undefined
      ? []
      : [{ label: facts.proxies, value: proxies.addresses.join(TEXT.listComma) || TEXT.none, mono: true }]),
    { label: facts.passphrase, value: TEXT.settings.madeBy.passphrase[settings.backupPassphrase], mono: false },
    {
      label: facts.offbox,
      value: settings.offboxBackupsConfigured ? TEXT.settings.configured : TEXT.settings.notConfigured,
      mono: false,
    },
  ];
  return (
    <dl className="card system-grid">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd className={row.mono ? "mono" : undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
