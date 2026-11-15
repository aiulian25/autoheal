import { useId, useState, type ReactNode } from "react";
import { TEXT } from "../../constants.js";

/** How many a card holds, for its folded line: nothing until they are known, then "none yet" or the count. */
export function countState(list: readonly unknown[] | undefined, count: (count: number) => string): string | null {
  if (list === undefined) return null;
  return list.length === 0 ? TEXT.settingsPage.fold.none : count(list.length);
}

/**
 * A settings card folded to one line: its title and how it stands now, opened to see or change the rest. It opens
 * by itself while something in it needs a person, until the person opens or closes it themself.
 */
export function SettingsFold({
  title,
  state,
  badge,
  attention = false,
  kind = "settings-card",
  dashed = false,
  children,
}: {
  title: string;
  state?: string | null;
  badge?: ReactNode;
  attention?: boolean;
  // A list of rows runs to the card's edges; anything else sits inside its padding.
  kind?: "settings-card" | "keys-card";
  // Not set up yet: drawn dashed, as an empty slot.
  dashed?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  const [chosen, setChosen] = useState<boolean | null>(null);
  return (
    <details
      className={`card fold settings-fold ${kind}${dashed ? " dashed" : ""}`}
      aria-labelledby={titleId}
      open={chosen ?? attention}
      onToggle={(event) => setChosen(event.currentTarget.open)}
    >
      <summary>
        <h3 id={titleId}>{title}</h3>
        {state && <span className="fold-state">{state}</span>}
        {badge}
      </summary>
      {children}
    </details>
  );
}
