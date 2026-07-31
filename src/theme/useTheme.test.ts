import { renderHook, act } from "@testing-library/react";
import { THEME_STORAGE_KEY, useTheme } from "./useTheme";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

test("with nothing stored, the choice is system and no attribute is set", () => {
  const { result } = renderHook(() => useTheme());
  expect(result.current.choice).toBe("system");
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
});

test("a stored choice wins and is applied as an attribute", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "terminal");
  const { result } = renderHook(() => useTheme());
  expect(result.current.choice).toBe("terminal");
  expect(document.documentElement.getAttribute("data-theme")).toBe("terminal");
});

/// A hand-edited or stale value must not apply a bogus attribute, which would
/// match no theme block and leave the app rendering :root's defaults while the
/// menu showed something else.
test("an unrecognised stored value falls back to system", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "solarized-pink");
  const { result } = renderHook(() => useTheme());
  expect(result.current.choice).toBe("system");
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
});

test("setChoice applies the attribute and persists", () => {
  const { result } = renderHook(() => useTheme());
  act(() => result.current.setChoice("instrument"));
  expect(document.documentElement.getAttribute("data-theme")).toBe("instrument");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("instrument");
});

test("choosing system again removes the attribute", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "console");
  const { result } = renderHook(() => useTheme());
  act(() => result.current.setChoice("system"));
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
});

/// Storage can throw outright (Safari private browsing). Losing the preference
/// is acceptable; failing to render is not.
test("a throwing localStorage does not break theme selection", () => {
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = () => {
    throw new Error("denied");
  };
  try {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setChoice("terminal"));
    expect(result.current.choice).toBe("terminal");
    expect(document.documentElement.getAttribute("data-theme")).toBe("terminal");
  } finally {
    Storage.prototype.setItem = setItem;
  }
});
