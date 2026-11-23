import type { Catalog } from "@der/domain";

const MAX_NAMES_PER_NAMESPACE = 8;

function namespaceLines(catalog: Catalog): string[] {
  const names = new Map<string, string[]>();
  for (const { id } of catalog.list()) {
    const [namespace = id, ...rest] = id.split(".");
    names.set(namespace, [...(names.get(namespace) ?? []), rest.join(".")]);
  }
  return [...names].map(([namespace, members]) => {
    const shown = members.slice(0, MAX_NAMES_PER_NAMESPACE).join(", ");
    const more =
      members.length > MAX_NAMES_PER_NAMESPACE
        ? `, and ${members.length - MAX_NAMES_PER_NAMESPACE} more`
        : "";
    return `- ${namespace}: ${shown}${more}`;
  });
}

export function codeModeInstructions(catalog: Catalog): string {
  const hasCatalogSearch = catalog.list().some((entry) => entry.id === "catalog.search");
  return [
    "You act on the host through two tools, `search` and `execute`.",
    "",
    "`search({ query })` returns TypeScript declarations and an example for the capabilities that match the query. Search before you write a Script; do not guess input shapes.",
    "`execute({ script })` runs a Script that calls capabilities and returns `{ ok: true, result, logs, truncated }` or `{ ok: false, error: { kind, message }, logs }`. It never throws: always check `ok`.",
    "",
    "Script rules:",
    "- A Script is the body of an async function. Give back a JSON value with `return`.",
    "- Call a capability as `der.<namespace>.<name>(input)`. It returns a Promise: `await` every call.",
    ...(hasCatalogSearch
      ? ["- `der.catalog.search(query)` searches the capabilities from inside a Script."]
      : []),
    "- Any `import` is rejected before the Script starts, including the text `import(` and a method named `.import(`. `eval` and `Function` are unavailable. There are no timers.",
    "- `Date`, `Math.random` and `performance.now` return recorded values, so a Script replays the same way every time. Do not branch on them.",
    "- A write can need operator approval. `execute` then waits for the decision. A denied or expired approval comes back as `ok: false` with kind `denied` or `expired`.",
    "- If your `execute` call is cut off, call it again with the identical Script to pick the same run back up. After a result has been returned, the same Script runs again.",
    "",
    "Example:",
    "```js",
    "const list = await der.routines.list({});",
    "return list.routines.map((routine) => routine.id);",
    "```",
    "",
    "Capability namespaces:",
    ...namespaceLines(catalog),
  ].join("\n");
}
