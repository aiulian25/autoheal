import { useState, type ReactNode } from "react";
import { Icon } from "../../components/icons.js";
import { TEXT } from "../../constants.js";

const text = TEXT.addContainer;

// One line of the screen: what, its value, why, and a way to change it in place.
export function Row({
  label,
  value,
  why,
  editor,
  warn = false,
}: {
  label: string;
  value: ReactNode;
  why?: string;
  editor?: (close: () => void) => ReactNode;
  warn?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <span className="install-label">{label}</span>
      {editing && editor !== undefined ? (
        <span className="install-editor">{editor(() => setEditing(false))}</span>
      ) : (
        <>
          <span className={warn ? "install-value text-warning" : "install-value"}>{value}</span>
          <span className="install-why muted" title={why}>
            {why}
          </span>
          <span className="install-change">
            {editor !== undefined && (
              <button type="button" className="link" onClick={() => setEditing(true)}>
                {text.change}
              </button>
            )}
          </span>
        </>
      )}
    </>
  );
}

export function TextEditor({
  label,
  initial,
  onSave,
  close,
  mono = true,
}: {
  label: string;
  initial: string;
  onSave: (value: string) => void;
  close: () => void;
  mono?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="install-edit"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(value.trim());
        close();
      }}
    >
      <input
        className={mono ? "mono" : undefined}
        aria-label={label}
        value={value}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit">{text.save}</button>
      <button type="button" className="quiet" onClick={close}>
        {text.cancel}
      </button>
    </form>
  );
}

// Options on the screen: a click selects one. Single choice unless \`several\`, where each click adds or takes away.
export function Choices<Value>({
  options,
  selected,
  onChoose,
  label,
  several = false,
}: {
  options: { value: Value; label: string; note?: string | undefined }[];
  selected: (value: Value) => boolean;
  onChoose: (value: Value) => void;
  label: string;
  // Any number of them at once: each carries a tick box, so the row does not read as one choice.
  several?: boolean;
}) {
  return (
    <span className="install-choices" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          className="install-choice"
          aria-pressed={selected(option.value)}
          onClick={() => onChoose(option.value)}
        >
          {several && <Icon name={selected(option.value) ? "check" : "square"} />}
          {option.label}
          {option.note !== undefined && <span className="install-choice-note">{option.note}</span>}
        </button>
      ))}
    </span>
  );
}

// A row of options, one of them "Other" where a person may need what was not thought of.
export function ChoiceRow({
  label,
  options,
  value,
  onChoose,
  other = false,
  mono = false,
}: {
  label: string;
  options: { value: string; label: string; note?: string | undefined }[];
  value: string;
  onChoose: (value: string) => void;
  other?: boolean;
  mono?: boolean;
}) {
  const offered = options.some((option) => option.value === value);
  const [typing, setTyping] = useState(false);
  return (
    <>
      <span className="install-label">{label}</span>
      <span className="install-row-choices">
        <Choices
          label={label}
          options={offered ? options : [...options, { value, label: value }]}
          selected={(candidate) => !typing && candidate === value}
          onChoose={(chosen) => {
            setTyping(false);
            onChoose(chosen);
          }}
        />
        {other && !typing && (
          <button type="button" className="install-choice" onClick={() => setTyping(true)}>
            {text.other}
          </button>
        )}
        {typing && (
          <TextEditor
            label={label}
            initial=""
            mono={mono}
            close={() => setTyping(false)}
            onSave={(typed) => {
              if (typed !== "") onChoose(typed);
            }}
          />
        )}
      </span>
    </>
  );
}
