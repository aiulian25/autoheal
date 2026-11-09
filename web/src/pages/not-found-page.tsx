import { Link } from "react-router";
import { TEXT, PATHS } from "../constants.js";

export function NotFoundPage() {
  return (
    <div className="page">
      <p className="muted">{TEXT.notFound}</p>
      <Link to={PATHS.home}>{TEXT.nav.attention}</Link>
    </div>
  );
}
