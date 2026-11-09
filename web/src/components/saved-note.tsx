import { useState, useRef, useEffect } from "react";
import { SAVED_NOTE_MILLISECONDS, TEXT } from "../constants.js";

/** "Saved", for a moment after a setting changed in place. */

export function useSavedNote() {
  const [shown, setShown] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = () => {
    setShown(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShown(false), SAVED_NOTE_MILLISECONDS);
  };
  return { shown, show };
}
export function SavedNote({ shown }: { shown: boolean }) {
  return shown ? (
    <span role="status" className="small saved-note">
      {TEXT.hostControl.saved}
    </span>
  ) : null;
}
