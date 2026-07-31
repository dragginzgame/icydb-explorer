import type { AppErrorDto } from "../api/types";

// The backend writes operator-facing explanations purpose-built for the
// failures users actually hit (SQL surface disabled, introspection off,
// non-controller identity, unreachable replica, a rejected statement).
// Those strings are the most valuable thing the backend produces for a
// failure, so this renders `explanation` verbatim — pre-wrapped, complete,
// never truncated or paraphrased.
export function ErrorBanner({ error }: { error: AppErrorDto }) {
  return (
    <div
      role="alert"
      className="rounded-control border border-danger-border bg-danger-bg p-3 text-sm text-danger-text"
    >
      <pre className="whitespace-pre-wrap font-prose">{error.explanation}</pre>
    </div>
  );
}
