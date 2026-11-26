export const onePersonMigration = {
  version: 79,
  name: "one_person",
  sql: `
-- Autoheal is one person's: once there is a user there is never another, and no second one may be active beside them.
-- Users from before stay as names in the history, kept from signing in when Autoheal starts.
CREATE TRIGGER users_one_person BEFORE INSERT ON users
WHEN EXISTS (SELECT 1 FROM users)
BEGIN
  SELECT RAISE(ABORT, 'one_person');
END;
CREATE TRIGGER users_one_active BEFORE UPDATE OF status ON users
WHEN NEW.status = 'active' AND EXISTS (SELECT 1 FROM users WHERE status = 'active' AND id <> NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'one_person');
END;
`,
};
