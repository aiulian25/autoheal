import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { HOST_SECTIONS } from "../../../src/shared/constants.js";
import { TEXT } from "../constants.js";

const SECTION_ORDER = [
  HOST_SECTIONS.overview,
  HOST_SECTIONS.containers,
  HOST_SECTIONS.updates,
  HOST_SECTIONS.dependencies,
  HOST_SECTIONS.control,
];

type Section = (typeof SECTION_ORDER)[number];

const isSectionOf = (sections: readonly Section[], hash: string): hash is Section =>
  (sections as readonly string[]).includes(hash);

// What a host without Docker has: its system and its packages. The rest is its containers', and comes back with Docker.
const WITHOUT_DOCKER: readonly Section[] = [HOST_SECTIONS.overview, HOST_SECTIONS.updates];

const sectionsOf = (docker: boolean): readonly Section[] => (docker ? SECTION_ORDER : WITHOUT_DOCKER);

/** The section crossing this share of the window's height is the one being read. */
const READING_LINE = 1 / 3;

/** Which section a person has scrolled to; null until they scroll, and again each time a tab jumps. */
function useSectionScrolledTo(docker: boolean, hash: string): Section | null {
  const [scrolledTo, setScrolledTo] = useState<Section | null>(null);
  useEffect(() => setScrolledTo(null), [hash]);
  useEffect(() => {
    const look = () => {
      const line = window.innerHeight * READING_LINE;
      const passed = sectionsOf(docker).filter(
        (section) => (document.getElementById(section)?.getBoundingClientRect().top ?? Infinity) <= line,
      );
      setScrolledTo(passed.at(-1) ?? null);
    };
    window.addEventListener("scroll", look, { passive: true });
    return () => window.removeEventListener("scroll", look);
  }, [docker]);
  return scrolledTo;
}

/** The page's sections as tabs that jump to them, the one being read underlined. */
export function HostTabs({
  containers,
  updates,
  docker,
  hidden,
  onContainers,
}: {
  containers: number;
  updates: number;
  docker: boolean;
  // Sections whose every card this browser hides: they are not on the page.
  hidden: readonly string[];
  onContainers: () => void;
}) {
  const hash = useLocation().hash.slice(1);
  const sections = sectionsOf(docker).filter((section) => !hidden.includes(section));
  const scrolledTo = useSectionScrolledTo(docker, hash);
  const jumpedTo = isSectionOf(sections, hash) ? hash : HOST_SECTIONS.overview;
  const active = scrolledTo ?? jumpedTo;
  const extras: Record<Section, ReactNode> = {
    overview: null,
    dependencies: null,
    containers: <span className="tab-count">{containers}</span>,
    updates: updates > 0 ? <span className="tab-pill">{updates}</span> : null,
    control: null,
  };
  return (
    <nav className="tabs host-tabs" aria-label={TEXT.hosts.tabs.label}>
      {sections.map((section) => (
        <a
          key={section}
          href={`#${section}`}
          aria-current={active === section ? "true" : undefined}
          onClick={section === HOST_SECTIONS.containers ? onContainers : undefined}
        >
          {TEXT.hosts.tabs[section]}
          {extras[section]}
        </a>
      ))}
    </nav>
  );
}
