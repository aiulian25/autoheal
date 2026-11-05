export const imageTrustMigration = {
  version: 62,
  name: "image_trust",
  sql: `
-- The publishers an admin trusts, by the public half of the key their signatures are made with, and where a signed
-- image is required before Autoheal puts one in place. A public key is not a secret, so it is kept as it was given.
CREATE TABLE trusted_publishers (
  name TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- A null repository is the whole registry; null publishers_json means any trusted publisher will do.
CREATE TABLE image_trust_rules (
  id TEXT PRIMARY KEY,
  registry TEXT NOT NULL,
  repository TEXT,
  publishers_json TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX image_trust_rules_scope ON image_trust_rules (registry, ifnull(repository, ''));
`,
};
