import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import type { HostPackagesView } from "../../../src/shared/api.js";
import { VERDICT_FIXED } from "../../../src/shared/constants.js";
import {
  carriesHandOver,
  droppedItems,
  handedCount,
  useHandOver,
  useSelection,
  hostsOfItems,
} from "../agent-dispatch.js";
import { lookAtPlaces, needsYouPlaces, snoozedTasks } from "../attention-places.js";
import { isIncident } from "../board.js";
import { ArrangeLine, CardGroup, usePageArrangement, type ArrangedCard } from "../components/arranged-cards.js";
import { ErrorNotice, Loading, PageHeader } from "../components/common.js";
import { ATTENTION_CARDS, ATTENTION_PLACE, CARD_PAGES, PATHS, TEXT } from "../constants.js";
import {
  boardQuery,
  containersQuery,
  enrolledHostsQuery,
  hostPackagesQuery,
  ollamaServersQuery,
  overviewQuery,
} from "../queries.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { type HandOver, SectionLabel } from "./attention/attention-parts.js";
import { FleetLine } from "./attention/fleet-line.js";
import { AllClear, LookAt, SnoozedFold } from "./attention/look-at.js";
import { PlaceCard } from "./attention/place-card.js";
import { OllamaCard } from "./attention/status-strip.js";
import { SideCard, CardList, AgentPill, ComingUp } from "./attention/side-cards.js";

/**
 * What needs a person now, one card for each place it happens on, then what waits for a look when they have time;
 * beside it, what Autoheal has in hand, has healed, and will do next.
 */
export function AttentionPage() {
  const session = useSignedInSession();
  const admin = isAdmin(session);
  const board = useQuery(boardQuery);
  const hosts = useQuery(enrolledHostsQuery);
  const containers = useQuery(containersQuery);
  const overview = useQuery(overviewQuery);
  const packages = useQueries({ queries: (hosts.data ?? []).map((host) => hostPackagesQuery(host.id)) });
  const selection = useSelection();
  const handOver = useHandOver();
  // How many the agent took last, said until the next hand-over.
  const [handed, setHanded] = useState<number | null>(null);
  // A hand-over on its way to the agent's card. With two columns the card is always in sight; in one, only meanwhile.
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
  // Null until Home Assistant is set up in Settings.
  const home = overview.data?.homeAssistant ?? null;
  const packageViews = new Map(
    hosts.data.flatMap((host, index): [string, HostPackagesView][] => {
      const view = packages[index]?.data;
      return view === undefined ? [] : [[host.id, view]];
    }),
  );
  const places = needsYouPlaces({
    board: board.data,
    hosts: hosts.data,
    containers: containers.data ?? [],
    packages: packageViews,
    homeAssistantUpdates: home?.connected === true ? home.system.updates : [],
  });
  const lookAt = lookAtPlaces(board.data);
  const lookAtCount = lookAt.reduce((sum, place) => sum + place.tasks.length, 0);
  const hostsNeeding = places.filter((place) => place.kind === ATTENTION_PLACE.host).length;
  const healed = done.filter((card) => isIncident(card) && card.incident.verdict === VERDICT_FIXED);
  const text = TEXT.attention;
  // Only the cards beside what needs a person may be pinned first or hidden, in this browser.
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
      <PageHeader title={text.title} lede={text.lede(needsYou.length, hostsNeeding, lookAtCount)}>
        <Link to={PATHS.board}>{text.allItems(needsYou.length + autoheal.length + noticed.length)}</Link>
      </PageHeader>
      <FleetLine hosts={hosts.data} />
      <div className="attention-layout">
        <div className="attention-main">
          {handed !== null && (
            <p className="small text-good" role="status">
              {TEXT.attention.agent.handed(handed)}
            </p>
          )}
          <ErrorNotice error={handOver.error} />
          {places.length > 0 && (
            <section className="attention-section">
              <SectionLabel tone="warning" text={text.needsYou} />
              {places.map((place) => (
                <PlaceCard
                  key={place.key}
                  place={place}
                  containers={containers.data ?? []}
                  viewerId={session.user.id}
                  admin={admin}
                  selection={selection}
                  onHandOver={give}
                  handing={handOver.isPending}
                />
              ))}
            </section>
          )}
          <LookAt places={lookAt} admin={admin} />
          {places.length === 0 && lookAt.length === 0 && (
            <AllClear board={board.data} containers={containers.data ?? []} />
          )}
          <SnoozedFold tasks={snoozedTasks(board.data)} admin={admin} />
        </div>
        <aside className="attention-side">
          <OllamaCard
            hosts={hosts.data}
            onHandOver={admin ? give : undefined}
            draggingHosts={draggingHosts}
            working={autoheal.length > 0}
          />
          <div className="attention-side-cards">
            <CardGroup cards={side} page={page} />
          </div>
        </aside>
      </div>
      <ArrangeLine cards={side} page={page} />
    </div>
  );
}
