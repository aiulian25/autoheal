import { useId, type ReactNode } from "react";

export interface Choice<Value extends string> {
  value: Value;
  label: string;
  note: string | null;
}

/** A question with its answers as radios, each with what it means under it when that needs saying. */
export function ChoiceCard<Value extends string>({
  title,
  name,
  choices,
  chosen,
  disabled,
  onChoose,
  children,
}: {
  title: string;
  name: string;
  choices: readonly Choice<Value>[];
  chosen: Value;
  disabled: boolean;
  onChoose: (value: Value) => void;
  children?: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="card choice-card">
      <h3 id={titleId}>{title}</h3>
      <div className="choice-options" role="radiogroup" aria-labelledby={titleId}>
        {choices.map((choice) => (
          <label key={choice.value} className="choice-option">
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={chosen === choice.value}
              disabled={disabled}
              onChange={() => onChoose(choice.value)}
            />
            <span className="choice-words">
              {choice.label}
              {choice.note !== null && <span className="small faint">{choice.note}</span>}
            </span>
          </label>
        ))}
      </div>
      {children}
    </section>
  );
}

export const choicesOf = <Value extends string>(
  values: readonly Value[],
  texts: Record<Value, { label: string; note: string | null }>,
): Choice<Value>[] => values.map((value) => ({ value, ...texts[value] }));
