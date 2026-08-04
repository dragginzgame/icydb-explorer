import type { AppErrorDto } from "./types";

function isAppErrorDto(value: unknown): value is AppErrorDto {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppErrorDto).kind === "string" &&
    typeof (value as AppErrorDto).explanation === "string"
  );
}

/** Normalises anything thrown into the one error shape the UI renders.
 *
 *  Its own module, deliberately, rather than living beside the `invoke` wrappers
 *  it started in. `api/commands` is mocked wholesale by the App tests — that is
 *  the point of it — and a pure helper inside a mocked module comes back
 *  `undefined`. That produced a banner with an undefined explanation, which
 *  renders as nothing: a failure that is caught, reported, and still invisible.
 *  Exactly the class of bug this function exists to prevent.
 *
 *  Failures do not only come from `invoke`. A Tauri *plugin* rejects with its own
 *  shape — a denied `dialog:allow-save` capability arrives as an `Error` — so
 *  every catch that feeds a setter typed as `AppErrorDto` goes through here rather
 *  than casting.
 */
export function toAppErrorDto(error: unknown): AppErrorDto {
  if (isAppErrorDto(error)) {
    return error;
  }
  const explanation = error instanceof Error ? error.message : String(error);

  return { kind: "unknown", explanation };
}
