import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { API_ROUTES, type AccountView } from "../../../../src/shared/api.js";
import { wordsOf } from "../../../../src/shared/constants.js";
import { api } from "../../api-client.js";
import { ErrorNotice } from "../../components/common.js";
import { PATHS, TEXT } from "../../constants.js";

const text = TEXT.settingsPage;

// --- People and keys ---------------------------------------------------------------------------------

export function PeopleSummary() {
  const people = useQuery({ queryKey: ["users"], queryFn: () => api<AccountView[]>("GET", API_ROUTES.users) });
  const list = people.data ?? [];
  const byRole = new Map<string, number>();
  for (const person of list) {
    byRole.set(person.role, (byRole.get(person.role) ?? 0) + 1);
  }
  const roles = [...byRole.entries()]
    .map(([role, count]) => text.people.roles(count, wordsOf(role)))
    .join(TEXT.listComma);
  return (
    <div className="card settings-row">
      <p>
        <strong>{text.people.count(list.length)}</strong>
        {roles !== "" && <span className="muted">{`${TEXT.separator}${roles}`}</span>}
      </p>
      <Link to={PATHS.users}>{text.people.manage}</Link>
      <ErrorNotice error={people.error} />
    </div>
  );
}
