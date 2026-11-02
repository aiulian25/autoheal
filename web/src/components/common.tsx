import { useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { wordsOf, JSON_INDENT, PERCENT } from "../../../src/shared/constants.js";
import { NavLink } from "react-router";
import type { ApiErrorCode } from "../../../src/shared/api.js";
import { ApiError, ReadableError } from "../api-client.js";
import {
  BADGE_TONES,
  COPY_FEEDBACK_MILLISECONDS,
  ERROR_TEXT,
  INTERACTIVE_ELEMENTS,
  METER_DANGER_PERCENT,
  METER_WARNING_PERCENT,
  TEXT,
  clockDriftText,
  tooManyAttemptsText,
  type Tone,
} from "../constants.js";
import { dateTime, percent, percentOf, timeAgo } from "../format.js";
import { PasskeyPromptStopped } from "../passkey-prompt.js";
import { Icon } from "./icons.js";

/** A value with the tone it is known for; `tone` overrides it for text built on the fly. */
export function Badge({ value, tone }: { value: string | null; tone?: Tone }) {
  if (value === null) {
    return <span className="muted">{TEXT.none}</span>;
  }
  return <span className={`badge ${tone ?? BADGE_TONES.get(value) ?? "neutral"}`}>{wordsOf(value)}</span>;
}

/**
 * A table row that opens its item from anywhere on it. A link or button inside the row already
 * acts on its own click; opening the row as well would navigate twice (and break Back).
 */
export const rowClick = (open: () => void) => (event: MouseEvent<HTMLElement>) => {
  const inner = event.target instanceof Element ? event.target.closest(INTERACTIVE_ELEMENTS) : null;
  if (inner === null) {
    open();
  }
};

export function TimeAgo({ timestamp }: { timestamp: number | null }) {
  if (timestamp === null) {
    return <span className="muted">{TEXT.none}</span>;
  }
  return <time title={dateTime(timestamp)}>{timeAgo(timestamp)}</time>;
}

function errorText(error: unknown): string {
  if (error instanceof ReadableError) {
    return error.message;
  }
  if (error instanceof PasskeyPromptStopped) {
    return error.alreadyHere ? TEXT.passkeys.alreadyHere : TEXT.passkeys.stopped;
  }
  if (!(error instanceof ApiError)) {
    return ERROR_TEXT.internal_error;
  }
  if (typeof error.body.retryAfterSeconds === "number") {
    return tooManyAttemptsText(error.body.retryAfterSeconds);
  }
  if (typeof error.body.clockOffsetSeconds === "number") {
    return clockDriftText(error.body.clockOffsetSeconds);
  }
  const message = Object.hasOwn(ERROR_TEXT, error.code) ? ERROR_TEXT[error.code as ApiErrorCode] : error.code;
  const problems = Array.isArray(error.body.problems) ? (error.body.problems as string[]) : [];
  return problems.length === 0 ? message : `${message}: ${problems.join("; ")}.`;
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (error === null || error === undefined) {
    return null;
  }
  return (
    <p className="notice error" role="alert">
      {errorText(error)}
    </p>
  );
}

/**
 * A password field with an eye that shows what was typed. Spell checking stays off: a cloud spell
 * checker (Chrome's enhanced one, Edge's Editor) would otherwise send a shown password away.
 */
export function PasswordInput({ label, ...input }: { label: string; name: string; autoComplete: string }) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-field">
      <label htmlFor={id}>{label}</label>
      <input
        {...input}
        id={id}
        type={visible ? "text" : "password"}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        required
      />
      <button
        type="button"
        className="reveal"
        aria-label={TEXT.showPassword}
        aria-pressed={visible}
        aria-controls={id}
        onClick={() => setVisible((shown) => !shown)}
      >
        <Icon name={visible ? "eyeSlashed" : "eye"} />
      </button>
    </div>
  );
}

export function Loading() {
  return <p className="muted">{TEXT.loading}</p>;
}

/** A page's title with a line on what it holds under it, and what can be done from it on the right. */
export function PageHeader({ title, lede, children }: { title: string; lede?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {lede !== undefined && <p className="lede">{lede}</p>}
      </div>
      {children}
    </header>
  );
}

/** Text from containers and the model is shown as text: never parsed as HTML. */
export function PlainText({ text, className = "log" }: { text: string; className?: string }) {
  return <pre className={className}>{text}</pre>;
}

// Within this many pixels of the end still counts as reading the newest line.
const FOLLOW_SLACK_PIXELS = 16;

/** A log that grows while it is read: it keeps to its newest line, unless the reader scrolled up. */
export function FollowedLog({ text, className = "log" }: { text: string; className?: string }) {
  const element = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (element.current !== null && following.current) {
      element.current.scrollTop = element.current.scrollHeight;
    }
  }, [text]);
  const noteWhere = () => {
    const log = element.current;
    if (log !== null) {
      following.current = log.scrollHeight - log.scrollTop - log.clientHeight <= FOLLOW_SLACK_PIXELS;
    }
  };
  return (
    <pre ref={element} className={className} onScroll={noteWhere}>
      {text}
    </pre>
  );
}

export const prettyJson = (value: unknown) => JSON.stringify(value, null, JSON_INDENT);

// A bar's ends are round: half its height in the stylesheet (--bar-height). Only its fill's far end is square.
const BAR_RADIUS = 3;
const FULL = "100%";

/** A rounded bar as full as `fraction`: SVG, so its width needs no inline style (CSP). */
export function Bar({ fraction, tone }: { fraction: number; tone: string }) {
  const clip = useId();
  const filled = `${Math.min(1, Math.max(0, fraction)) * PERCENT}%`;
  return (
    <svg className={`bar tone-${tone}`} aria-hidden>
      <clipPath id={clip}>
        <rect width={FULL} height={FULL} rx={BAR_RADIUS} />
      </clipPath>
      <g clipPath={`url(#${clip})`}>
        <rect className="bar-track" width={FULL} height={FULL} />
        <rect className="bar-fill" width={filled} height={FULL} />
      </g>
    </svg>
  );
}

/** How full something is, as a native meter: amber past 75%, red past 90%. No inline styles (CSP). */
export function UsageMeter({ used, total, label }: { used: number; total: number; label: string }) {
  const value = percentOf(used, total);
  return (
    <span className="usage">
      <meter
        min={0}
        max={PERCENT}
        low={METER_WARNING_PERCENT}
        high={METER_DANGER_PERCENT}
        optimum={0}
        value={value}
        aria-label={label}
      />
      <span className="small">{percent(value)}</span>
    </span>
  );
}

export function Tabs({ label, items }: { label: string; items: readonly { path: string; label: string }[] }) {
  return (
    <nav className="tabs" aria-label={label}>
      {items.map((item) => (
        <NavLink key={item.path} to={item.path}>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Copies the displayed text, with bounded success feedback and a safe manual-copy fallback. */
export function CopyButton({ text }: { text: string }) {
  const [feedback, setFeedback] = useState<"copied" | "failed" | null>(null);
  const [copying, setCopying] = useState(false);
  const attempt = useRef(0);
  useLayoutEffect(() => {
    ++attempt.current;
    setFeedback(null);
    setCopying(false);
    return () => {
      ++attempt.current;
    };
  }, [text]);
  useLayoutEffect(() => {
    if (feedback !== "copied") return;
    const timer = window.setTimeout(() => setFeedback(null), COPY_FEEDBACK_MILLISECONDS);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  const copy = async () => {
    const current = ++attempt.current;
    setFeedback(null);
    setCopying(true);
    try {
      await navigator.clipboard.writeText(text);
      if (attempt.current === current) setFeedback("copied");
    } catch {
      // Clipboard errors may contain the copied secret. Never retain or display their details.
      if (attempt.current === current) setFeedback("failed");
    } finally {
      if (attempt.current === current) setCopying(false);
    }
  };
  return (
    <span className="row" role="status" aria-live="polite" aria-atomic="true">
      <button type="button" disabled={copying} onClick={copy}>
        {feedback === "copied" ? TEXT.copied : TEXT.copy}
      </button>
      {feedback === "failed" && <span className="small text-danger">{TEXT.copyFailed}</span>}
    </span>
  );
}

/** One numbered step of a few, the one to do now outlined. */
export function Step({
  number,
  title,
  active,
  children,
}: {
  number: number;
  title: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <li className={active ? "step-card active" : "step-card"} aria-current={active ? "step" : undefined}>
      <h3 className="step-title">
        <span className="step-number">{number}</span>
        <span>{title}</span>
      </h3>
      {children}
    </li>
  );
}
