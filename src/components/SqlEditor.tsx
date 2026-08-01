import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";

import type { EntityDto, SchemaDto } from "../api/types";
import { suggestSql } from "../lib/suggestSql";

/** Syntax colours, drawn from the app's own tokens.
 *
 *  Existing semantic tokens rather than a parallel syntax palette: all three
 *  themes already tune these, so highlighting follows a theme switch for free
 *  and there is no second set of colours to keep in step. `var()` also means no
 *  literal colour reaches a component file, which `tokens-only.test.ts` enforces.
 *
 *  Strings and numbers deliberately share one colour. Four roles is what this
 *  vocabulary supports — `--accent` and `--pk` are the same value in Console, so
 *  splitting literals in two would produce a distinction that vanishes in one
 *  theme and looks like a bug in the others. */
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--accent)", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--warn-text)" },
  { tag: tags.number, color: "var(--warn-text)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--text-3)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--text-3)" },
  { tag: tags.typeName, color: "var(--pk)" },
]);

/** The editor chrome, also through tokens so it matches the surrounding pane. */
const theme = EditorView.theme({
  "&": {
    fontSize: "0.875rem",
    border: "1px solid var(--rule)",
    borderRadius: "var(--r-control)",
    backgroundColor: "var(--surface-0)",
    color: "var(--text-1)",
  },
  "&.cm-focused": { outline: "2px solid var(--accent)", outlineOffset: "-1px" },
  ".cm-content": { fontFamily: "var(--mono-font)", padding: "0.5rem" },
  ".cm-cursor": { borderLeftColor: "var(--text-1)" },
  ".cm-placeholder": { color: "var(--text-3)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--sel-bg)",
    color: "var(--sel-text)",
  },
  ".cm-tooltip-autocomplete": {
    border: "1px solid var(--rule)",
    backgroundColor: "var(--surface-2)",
    color: "var(--text-1)",
    fontFamily: "var(--mono-font)",
    fontSize: "0.75rem",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--sel-bg)",
    color: "var(--sel-text)",
  },
  ".cm-completionDetail": { color: "var(--text-3)", fontStyle: "normal", marginLeft: "0.5rem" },
});

/** Adapts `suggestSql` to CodeMirror's completion protocol.
 *
 *  Exported and given the sources through a getter rather than captured, so the
 *  boundary between this app's suggestion logic and the editor can be tested
 *  without mounting one — and so the editor, built once, still sees a schema
 *  that arrives later.
 */
export function sqlCompletionSource(
  sources: () => { entities?: EntityDto[] | null; schema?: SchemaDto | null },
) {
  return (context: CompletionContext) => {
    // Everything up to the cursor, which is exactly what `suggestSql` reasons
    // about — it takes "the statement as typed so far".
    const upToCursor = context.state.sliceDoc(0, context.pos);
    const word = /[A-Za-z_][A-Za-z0-9_]*$/.exec(upToCursor);
    // Only open unprompted at a word or just after whitespace; otherwise the
    // popup appears mid-punctuation where there is nothing useful to offer.
    if (!word && !context.explicit && !/\s$/.test(upToCursor)) return null;

    const { entities, schema } = sources();
    const suggestions = suggestSql(upToCursor, entities ?? null, schema ?? null);
    if (suggestions.length === 0) return null;

    return {
      // Replace the partial word, not insert beside it — otherwise completing
      // `us` to `User` leaves `usUser`.
      from: word ? context.pos - word[0].length : context.pos,
      options: suggestions.map((suggestion) => ({
        label: suggestion.text,
        type: suggestion.kind === "keyword" ? "keyword" : suggestion.kind,
        detail: suggestion.detail,
      })),
    };
  };
}

/** A SQL editor with highlighting and schema-driven completion.
 *
 *  The completion source is `suggestSql`, the same function the plain-textarea
 *  console used — so what gets suggested, and the reasoning about when tables
 *  versus columns are the answer, is unchanged and still unit-tested away from
 *  any editor. This file is presentation: highlighting, the popup, and keys.
 */
export function SqlEditor({
  value,
  onChange,
  entities,
  schema,
}: {
  value: string;
  onChange: (value: string) => void;
  entities?: EntityDto[] | null;
  schema?: SchemaDto | null;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // The completion source is rebuilt on every keystroke otherwise, and
  // CodeMirror holds the extension from construction — so the schema is read
  // through a ref rather than captured.
  const sources = useRef({ entities, schema });
  sources.current = { entities, schema };
  const notify = useRef(onChange);
  notify.current = onChange;

  useEffect(() => {
    if (!host.current || view.current) return;

    view.current = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          sql(),
          syntaxHighlighting(highlight),
          autocompletion({
            override: [sqlCompletionSource(() => sources.current)],
            icons: false,
          }),
          placeholder("SELECT * FROM ..."),
          EditorView.lineWrapping,
          theme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) notify.current(update.state.doc.toString());
          }),
        ],
      }),
    });

    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // Constructed once. `value` is synced by the effect below rather than by
    // rebuilding the editor, which would drop the cursor and the undo history
    // on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push an externally-set value in — the ORDER BY assist rewrites the
  // statement from outside the editor. Guarded on inequality so this does not
  // fight the user's own typing, which arrives here as an echo of itself.
  useEffect(() => {
    const current = view.current;
    if (!current) return;
    const doc = current.state.doc.toString();
    if (doc === value) return;
    current.dispatch({ changes: { from: 0, to: doc.length, insert: value } });
  }, [value]);

  return <div ref={host} data-sql-editor />;
}
