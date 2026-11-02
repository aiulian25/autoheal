import { TASK_SNOOZES, type TaskSnooze } from "../../../src/shared/constants.js";
import { TEXT } from "../constants.js";

/** How long to put a warning off, one press for each length. */
export function SnoozeChoices({ disabled, onChoose }: { disabled: boolean; onChoose: (length: TaskSnooze) => void }) {
  const text = TEXT.tasks.snooze;
  return (
    <span className="snooze-choices" role="group" aria-label={text.label}>
      <span className="small muted">{text.label}</span>
      {TASK_SNOOZES.map((length) => (
        <button
          key={length}
          type="button"
          className="quiet"
          disabled={disabled}
          aria-label={text.choice(text.lengths[length])}
          onClick={() => onChoose(length)}
        >
          {text.lengths[length]}
        </button>
      ))}
    </span>
  );
}
