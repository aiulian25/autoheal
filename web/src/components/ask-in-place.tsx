import { useState, type FormEvent } from "react";
import { TEXT } from "../constants.js";

interface Question {
  text: string;
  go: (answer: string) => void;
  // A name asked for, starting as this; null for a plain yes or no.
  initial: string | null;
  // Whether a name must be given; where none may be, leaving it empty is an answer too.
  required: boolean;
}

function InPlaceQuestion({ question, onDone }: { question: Question; onDone: () => void }) {
  const [answer, setAnswer] = useState(question.initial ?? "");
  const asksName = question.initial !== null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const given = answer.trim();
    if (asksName && question.required && given === "") return;
    onDone();
    question.go(given);
  };
  return (
    <form className="ask-in-place row" role="group" aria-label={question.text} aria-live="polite" onSubmit={submit}>
      {asksName ? (
        <label>
          {question.text}
          <input
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            required={question.required}
            autoFocus
          />
        </label>
      ) : (
        <span>{question.text}</span>
      )}
      <button type="submit" className={asksName ? "primary" : "primary danger"}>
        {asksName ? TEXT.askInPlace.save : TEXT.yes}
      </button>
      <button type="button" onClick={onDone}>
        {asksName ? TEXT.askInPlace.cancel : TEXT.no}
      </button>
    </form>
  );
}

/**
 * Asks in place, where the card shows `question`, before what cannot be taken back, or for a name: the browser's own
 * dialog would stop the whole page, and a browser may stop showing it after a few.
 */
export function useAskInPlace() {
  const [question, setQuestion] = useState<Question | null>(null);
  const confirm = (text: string, go: () => void) =>
    setQuestion({ text, go: () => go(), initial: null, required: false });
  const askName = (text: string, initial: string, go: (name: string) => void, { required = true } = {}) =>
    setQuestion({ text, go, initial, required });
  const shown =
    question === null ? null : (
      <InPlaceQuestion
        key={`${question.text}\u0000${question.initial ?? ""}`}
        question={question}
        onDone={() => setQuestion(null)}
      />
    );
  return { confirm, askName, question: shown };
}
