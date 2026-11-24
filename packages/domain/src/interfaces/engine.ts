import type { EngineKind } from "../schemas/common";
import type { EngineEvent, EngineReadiness } from "../schemas/execution";
import type { Run } from "../schemas/run";

export interface Engine {
  readonly kind: EngineKind;
  /** Resumes its vendor session across Runs; otherwise every Run rebuilds the context. */
  readonly resumable?: boolean;
  run(run: Run): AsyncIterable<EngineEvent>;
  diagnose?(): Promise<EngineReadiness>;
}
