// No table changes: the control plane seals the stored secrets itself when it opens this file. The version is the
// point: an older Autoheal would read the sealed values as plain text, so it has to refuse the file instead.
export const sealedSecretsMigration = {
  version: 31,
  name: "sealed-secrets",
  sql: "SELECT 1;",
};
