export const joinCodesMigration = {
  version: 70,
  name: "join_codes",
  sql: `
-- A runner host's join code while it waits to be traded for its runner's token: its hash, and when it stops working.
-- Null once traded, and for a host that joined before codes worked once.
ALTER TABLE hosts ADD COLUMN join_code_hash TEXT;
ALTER TABLE hosts ADD COLUMN join_code_expires_at INTEGER;
`,
};
