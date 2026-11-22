import type {
  ChannelBinding,
  ChannelUpdate,
  DeliveryResult,
  OutboxEvent,
} from "../schemas/channel";

export interface Messaging {
  poll(cursor: string | undefined): AsyncIterable<ChannelUpdate>;
  deliver(binding: ChannelBinding, event: OutboxEvent): Promise<DeliveryResult>;
}
