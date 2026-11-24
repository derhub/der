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
    '`execute({ script })` runs a Script that calls capabilities. A Script that ends within a few seconds returns `{ ok: true, result, logs, truncated }` or `{ ok: false, error: { kind, message }, logs }`. A Script still running then returns `{ status: "pending", executionId, proposedWrites }`. `execute` never throws: check `ok` and `status`.',
    "",
    "A Script is the body of an `async` function. Each `step.run(...)` hands one step to the host and returns a promise for its result. `await` works anywhere in the body.",
    "",
    "The calls:",
    "- `step.run(id, input)` performs a read or a write and returns a promise for its result: plain JSON. `id` is a capability id as a string. `input` is plain JSON. Search first for the input and output shape.",
    '- `step.all([promise, promise, ...])` waits for all of them and returns their results in the same order. `step.allSettled([...])` returns, for each, `{ status: "fulfilled", value }` or `{ status: "rejected", reason }`.',
    "- Calling `step.run` starts the step at once. Steps started before the next `await` run together. Steps in `step.all` therefore run together: await writes one after another when their order matters.",
    ...(hasCatalogSearch
      ? [
          "- `await step.run('catalog.search', query)` searches the capabilities from inside a Script.",
        ]
      : []),
    "",
    "Script rules:",
    "- Write `await` in front of every `step.run`, or collect the promises in `step.all`. A step you start and never await still runs, and its error becomes the result; if you read nothing from it, the host reports the rejection when the Script ends.",
    "- Variables, loops, closures, helper `async` functions and `try`/`catch` work as in any JavaScript. Use `for (const x of xs) { await ... }` for steps in order. `xs.forEach(async ...)` does not wait.",
    "- To run steps for many items together: `await step.all(items.map(async (item) => { ... await step.run(...) ... }))`.",
    "- Pass results, not promises: `const d = await step.run('docs.create', { title: 'T' });` then `{ docId: d.id }`. An input is plain JSON: no `undefined`, functions, `Date` or promises.",
    "- The Script's `return` value is its result: plain JSON. Modules, `import`, `eval`, `Function` and timers are not available.",
    "- A Script must do the same thing every time it runs. The host may run it again from the top to resume it, replaying stored results. `Date`, `Math.random` and `performance.now` return recorded values; do not branch on anything else that changes between runs. A Script that does not repeat itself stops with an error and applies nothing more.",
    "- A Script that fails leaves its earlier writes applied. Nothing is rolled back; read the error and decide what to do about the writes that went through.",
    "",
    "Failure:",
    "- A failed read or write rejects its promise. The error has `kind` (`failed`, `denied`, `expired` or `refused`), `message`, `step`, `capability` and `input`. Handle it with `try`/`catch`; an error that is not caught fails the Script.",
    "- A write can need operator approval. The step then waits for the decision. A denied or expired approval rejects that step with kind `denied` or `expired`, and only that step; catch it to continue. Policy can also refuse a capability with kind `refused`.",
    "- A write whose outcome is unknown never throws: the Script stops, the write is not repeated, and the result says so. Check before you try again.",
    "",
    "Pending:",
    '- `{ status: "pending", executionId, proposedWrites }` means the Script is still running, usually because a write waits for an operator. `proposedWrites` lists those writes with their `position`, `capability` and `input`; it is empty when none waits. Tell the operator what is waiting, then end your turn. Do not call `execute` again for the same work.',
    '- When the Script ends, its outcome arrives as a new message: JSON with `event: "script.finished"`, the `executionId`, the `status` and the `result` in the shape above. Act on it then.',
    "- If your `execute` call is cut off, call it again with the identical Script to reattach to an unfinished execution. After an execution ends, the same Script starts a new occurrence.",
    "",
    "Example:",
    "```js",
    "const list = await step.run('routines.list', {});",
    "return list.routines.map((routine) => routine.id);",
    "```",
    "",
    "Capability namespaces:",
    ...namespaceLines(catalog),
  ].join("\n");
}
