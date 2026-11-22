import type { BotId } from "../schemas/common";
import type { MemoryRecord, MemoryWriteInput } from "../schemas/memory";

export interface Memory {
  read(botId: BotId, version?: number): Promise<MemoryRecord | undefined>;
  write(input: MemoryWriteInput): Promise<MemoryRecord>;
}
