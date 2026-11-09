import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { API_ROUTES, apiPath, type PromptSnapshotView } from "../../../src/shared/api.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading, PageHeader, PlainText } from "../components/common.js";
import { TEXT } from "../constants.js";

export function PromptPage() {
  const { promptHash = "" } = useParams();
  const prompt = useQuery({
    queryKey: ["prompts", promptHash],
    queryFn: () => api<PromptSnapshotView>("GET", apiPath(API_ROUTES.prompt, { promptHash })),
  });
  return (
    <div className="page">
      <PageHeader title={TEXT.prompt.title} lede={TEXT.prompt.explanation} />
      <p className="mono small">{promptHash}</p>
      {prompt.data === undefined ? <Loading /> : <PlainText text={prompt.data.systemPrompt} />}
      <ErrorNotice error={prompt.error} />
    </div>
  );
}
