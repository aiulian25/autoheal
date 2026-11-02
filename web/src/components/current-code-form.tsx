import type { FormEvent } from "react";
import { TEXT } from "../constants.js";
import { ErrorNotice } from "./common.js";

/** A current code first, as signing in asks: a session left open is not enough on its own. */
export function CurrentCodeForm({
  action,
  pending,
  error,
  onCode,
  onCancel,
}: {
  action: string;
  pending: boolean;
  error: unknown;
  onCode: (code: string) => void;
  onCancel: () => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onCode(String(new FormData(event.currentTarget).get("code") ?? ""));
  };
  return (
    <form className="stack" onSubmit={submit}>
      <label>
        {TEXT.account.currentCode}
        <input name="code" autoComplete="one-time-code" required autoFocus />
      </label>
      <ErrorNotice error={error} />
      <div className="row">
        <button className="primary" type="submit" disabled={pending}>
          {action}
        </button>
        <button type="button" onClick={onCancel}>
          {TEXT.account.cancel}
        </button>
      </div>
    </form>
  );
}
