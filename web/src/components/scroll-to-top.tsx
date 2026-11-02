import { useEffect, useState } from "react";
import { MAP_VIEW, TEXT } from "../constants.js";
import { Icon } from "./icons.js";

const SHOWN_AFTER_PIXELS = 400;

/** Back to the top of a long page: there once a person has scrolled away from it, on every page. */
export function ScrollToTop() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const follow = () => setShown(window.scrollY > SHOWN_AFTER_PIXELS);
    follow();
    window.addEventListener("scroll", follow, { passive: true });
    return () => window.removeEventListener("scroll", follow);
  }, []);
  if (!shown) return null;
  const toTop = () => {
    const calm = window.matchMedia?.(MAP_VIEW.reducedMotion).matches ?? true;
    window.scrollTo({ top: 0, behavior: calm ? "auto" : "smooth" });
  };
  return (
    <button
      type="button"
      className="icon-button scroll-to-top"
      title={TEXT.scrollToTop}
      aria-label={TEXT.scrollToTop}
      onClick={toTop}
    >
      <Icon name="arrowUp" />
    </button>
  );
}
