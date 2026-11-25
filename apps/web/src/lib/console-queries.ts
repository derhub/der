import { QueryClient } from "@tanstack/react-query";

export const consoleQueryKeys = {
  health: () => ["console", "health"] as const,
  engines: () => ["console", "engines"] as const,
  capabilities: () => ["console", "capabilities"] as const,
  bots: () => ["console", "bots"] as const,
  sessions: (botId: string) => ["console", "sessions", botId] as const,
};

export function createConsoleQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}
