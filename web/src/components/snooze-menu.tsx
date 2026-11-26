import { TASK_SNOOZES, type TaskSnooze } from "../../../src/shared/constants.js";
import { TEXT } from "../constants.js";

// Nothing chosen: the menu shows its own name, and goes back to it after each choice.
const UNCHOSEN = "";

/** How long to put something off, from one menu: choosing a length puts it off at once. */
export function SnoozeMenu({ disabled, onChoose }: { disabled: boolean; onChoose: (length: TaskSnooze) => void }) {
  const text = TEXT.tasks.snooze;
  return (
    <select
      className="snooze-menu"
      aria-label={text.label}
      value={UNCHOSEN}
      disabled={disabled}
      onChange={(event) => {
        const length = TASK_SNOOZES.find((candidate) => candidate === event.currentTarget.value);
        if (length !== undefined) onChoose(length);
      }}
    >
      <option value={UNCHOSEN} disabled hidden>
        {text.label}
      </option>
      {TASK_SNOOZES.map((length) => (
        <option key={length} value={length}>
          {text.lengths[length]}
        </option>
      ))}
    </select>
  );
}
