import { defineCapability, sandboxRequest, sandboxResult, type Sandbox } from "@der/domain";

export function sandboxCapability(kind: "docker" | "wasmer", sandbox: Sandbox) {
  return defineCapability({
    id: `sandbox.${kind}`,
    description: `Run a bounded command inside the ${kind} sandbox. Asks for approval unless the bot's policy allows it.`,
    input: sandboxRequest,
    output: sandboxResult,
    effect: "write",
    approval: "always",
    example: `await step.run("sandbox.${kind}", { command: "echo", args: ["hi"], timeoutMs: 5000, network: "none" })`,
    execute: (input) => sandbox.execute(input),
  });
}
