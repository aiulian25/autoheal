import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { VERDICT_FIXED } from "../../../src/shared/constants.js";
import {
  carriesHandOver,
  droppedItems,
  handedCount,
  useHandOver,
  useSelection,
  hostsOfItems,
} from "../agent-dispatch.js";
import { isIncident, isTask, isUpdateTask, whatNeedsYou } from "../board.js";
import { ArrangeLine, CardGroup, usePageArrangement, type ArrangedCard } from "../components/arranged-cards.js";
import { ErrorNotice, Loading, PageHeader } from "../components/common.js";
import { ATTENTION_CARDS, CARD_PAGES, PATHS, TEXT } from "../constants.js";
import { boardQuery, containersQuery, enrolledHostsQuery, ollamaServersQuery, overviewQuery } from "../queries.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { type HandOver, SectionLabel } from "./attention/attention-parts.js";
import { StatusStrip } from "./attention/status-strip.js";
import { DecisionCard } from "./attention/decision-card.js";
import { FixCard } from "./attention/fix-card.js";
import { Updates } from "./attention/updates.js";
import { SideCard, CardList, AgentPill, ComingUp } from "./attention/side-cards.js";

/** What needs a person now, then what Autoheal has in hand, has healed, and will do next. */
export function AttentionPage() {
  const session = useSignedInSession();
  const admin = isAdmin(session);
  const board = useQuery(boardQuery);
  const hosts = useQuery(enrolledHostsQuery);
  const containers = useQuery(containersQuery);
  const overview = useQuery(overviewQuery);
  const selection = useSelection();
  const handOver = useHandOver();
  // How many the agent took last, said until the next hand-over.
  const [handed, setHanded] = useState<number | null>(null);
  // A hand-over on its way to the agent's card, which stays in sight meanwhile.
  const [dragging, setDragging] = useState(false);
  const [draggingHosts, setDraggingHosts] = useState<readonly (string | null)[]>([]);
  const servers = useQuery(ollamaServersQuery);
  const page = usePageArrangement(CARD_PAGES.attention);
  const stopDragging = () => {
    setDragging(false);
    setDraggingHosts([]);
  };
  const give: HandOver = (items) => {
    setHanded(null);
    handOver.mutate(items, {
      onSuccess: (view) => {
        setHanded(handedCount(view));
        selection.select([]);
      },
    });
  };
  if (board.data === undefined || hosts.data === undefined) {
    return (
      <div className="page">
        <ErrorNotice error={board.error ?? hosts.error} />
        {board.error === null && hosts.error === null && <Loading />}
      </div>
    );
  }
  const { needsYou, autoheal, noticed, done } = board.data;
  const hostOf = (hostId: string | null) => hosts.data.find((host) => host.id === hostId);
  const containerOn = (hostId: string, name: string) =>
    containers.data?.find((container) => container.hostId === hostId && container.name === name);
  const { decisions, problems } = whatNeedsYou(needsYou);
  const updateTasks = [...needsYou, ...noticed, ...autoheal]
    .filter(isTask)
    .map((card) => card.task)
    .filter(isUpdateTask);
  const healed = done.filter((card) => isIncident(card) && card.incident.verdict === VERDICT_FIXED);
  // Null until Home Assistant is set up in Settings.
  const home = overview.data?.homeAssistant ?? null;
  const text = TEXT.attention;
  // What needs a person keeps its place above them: only these may be pinned first or hidden, in this browser.
  const updates: ArrangedCard[] = [
    {
      id: ATTENTION_CARDS.updates,
      title: text.sections.updates.label,
      node: (
        <Updates
          tasks={updateTasks}
          hosts={hosts.data}
          containers={containers.data ?? []}
          homeAssistantUpdates={home?.connected === true ? home.system.updates : []}
          admin={admin}
          selection={selection}
          onHandOver={give}
          handing={handOver.isPending}
        />
      ),
    },
  ];
  const side: ArrangedCard[] = [
    {
      id: ATTENTION_CARDS.onItNow,
      title: text.onItNow,
      node: (
        <SideCard title={text.onItNow}>
          <div className="side-row">
            <CardList cards={autoheal} empty={text.nothingInHand} servers={servers.data} />
            <AgentPill hosts={hosts.data} working={autoheal.length > 0} />
          </div>
        </SideCard>
      ),
    },
    {
      id: ATTENTION_CARDS.healed,
      title: text.healed,
      node: (
        <SideCard title={text.healed}>
          <CardList cards={healed} empty={text.nothingHealed} />
        </SideCard>
      ),
    },
    { id: ATTENTION_CARDS.comingUp, title: text.comingUp, node: <ComingUp admin={admin} /> },
    {
      id: ATTENTION_CARDS.howFar,
      title: text.howFar,
      node: (
        <SideCard title={text.howFar} muted>
          <p className="small muted">
            {text.howFarBefore}
            <code>{text.howFarCommand}</code>
            {text.howFarAfter}
          </p>
          <Link className="small" to={PATHS.runbooks}>
            {text.changeRules}
          </Link>
        </SideCard>
      ),
    },
  ];
  return (
    <div
      className={dragging ? "page attention dragging" : "page attention"}
      onDragStart={(event) => {
        setDragging(carriesHandOver(event));
        setDraggingHosts(hostsOfItems(droppedItems(event), [...needsYou, ...noticed, ...autoheal]));
      }}
      onDragEnd={stopDragging}
      onDrop={stopDragging}
    >
      <PageHeader title={text.title} lede={text.lede(needsYou.length)}>
        <Link to={PATHS.board}>{text.allItems(needsYou.length + autoheal.length + noticed.length)}</Link>
      </PageHeader>
      <StatusStrip
        hosts={hosts.data}
        containers={containers.data ?? []}
        onHandOver={admin ? give : undefined}
        draggingHosts={draggingHosts}
        working={autoheal.length > 0}
      />
      <div className="attention-layout">
        <div className="attention-main">
          {handed !== null && (
            <p className="small text-good" role="status">
              {TEXT.attention.agent.handed(handed)}
            </p>
          )}
          <ErrorNotice error={handOver.error} />
          {decisions.length > 0 && (
            <section className="attention-section">
              <SectionLabel tone="warning" text={text.sections.decide} />
              {decisions.map((card) => (
                <DecisionCard
                  key={card.incident.id}
                  incident={card.incident}
                  host={hostOf(card.incident.hostId)}
                  container={containerOn(card.incident.hostId, card.incident.containerName)}
                  admin={admin}
                  onHandOver={give}
                />
              ))}
            </section>
          )}
          {problems.length > 0 && (
            <section className="attention-section">
              <SectionLabel tone="danger" text={text.sections.fix} />
              <div className="fix-grid">
                {problems.map((card) => (
                  <FixCard
                    key={card.task.id}
                    task={card.task}
                    host={hostOf(card.task.hostId)}
                    viewerId={session.user.id}
                    admin={admin}
                  />
                ))}
              </div>
            </section>
          )}
          <CardGroup cards={updates} page={page} />
          {needsYou.length === 0 && <p className="card muted">{text.nothingNeedsYou}</p>}
        </div>
        <aside className="attention-side">
          <CardGroup cards={side} page={page} />
        </aside>
      </div>
      <ArrangeLine cards={[...updates, ...side]} page={page} />
    </div>
  );
}
