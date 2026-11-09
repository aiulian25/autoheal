import { type QueryClient } from "@tanstack/react-query";
import { type SettingsView } from "../../../../src/shared/api.js";
import { settingsQuery } from "../../queries.js";

export function refreshSettingsNotice(queryClient: QueryClient) {
  if (queryClient.getQueryData<SettingsView>(settingsQuery.queryKey)?.invalidSettings?.length)
    return queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey });
  return Promise.resolve();
}
