import { Link } from "react-router";
import { PATHS, TEXT } from "../constants.js";

/** In place of a page that failed to render. React Router has already written the error to the console. */
export function RouteError() {
  return (
    <div className="page">
      <p className="notice error" role="alert">
        {TEXT.routeError.message}
      </p>
      <div className="card-actions">
        <button type="button" className="primary" onClick={() => window.location.reload()}>
          {TEXT.routeError.reload}
        </button>
        <Link to={PATHS.home}>{TEXT.nav.attention}</Link>
      </div>
    </div>
  );
}
