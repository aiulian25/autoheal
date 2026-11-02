// What each key reads: the keys made before this read Homepage's counts.
export const widgetKeyScopeMigration = {
  version: 35,
  name: "widget-key-scope",
  sql: `
ALTER TABLE widget_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'widget';
`,
};
