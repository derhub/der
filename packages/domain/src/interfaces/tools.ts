import type { ToolDescriptor, ToolOperation, ToolResult } from "../schemas/execution";

export interface Tools {
  list?(): Promise<readonly ToolDescriptor[]>;
  invoke(operation: ToolOperation): Promise<ToolResult>;
}
