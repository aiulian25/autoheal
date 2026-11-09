import { Icon } from "../../components/icons.js";
import { TEXT } from "../../constants.js";

// Updates and escalated incidents dropped on the Ollama agent's card, as their keys.
export type HandOver = (items: readonly string[]) => void;

// The default has no name of its own.
export const serverLabel = (name: string | null) => name ?? TEXT.attention.ollama.defaultName;

// The handle a row or card is dragged by onto the Ollama agent: its words are the tick's, or the card's button.
export const Grip = () => <Icon name="grip" className="grip" />;

export function SectionLabel({
  tone,
  text,
}: {
  tone: "warning" | "danger" | "accent";
  text: { label: string; hint: string };
}) {
  return (
    <h2 className={`section-label tone-${tone}`}>
      {text.label}
      <span className="section-hint">{text.hint}</span>
    </h2>
  );
}
