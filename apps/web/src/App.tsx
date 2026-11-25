import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Theme } from "@astryxdesign/core/theme";
import {
  colorVars,
  spacingVars,
  textSizeVars,
  typographyVars,
} from "@astryxdesign/core/theme/tokens.stylex";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import * as stylex from "@stylexjs/stylex";
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIcon,
  BookOpenIcon,
  BrainIcon,
  CalendarClockIcon,
  MessageSquareIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Bot, CapabilityDescriptor, EngineReadiness, Session } from "@der/domain";
import { ChatWorkspace } from "@/components/chat-workspace";
import { MemoryPanel } from "@/components/memory-panel";
import { OperatorSidebar } from "@/components/operator-sidebar";
import { ProblemAlert } from "@/components/problem-alert";
import { ReadinessPanel } from "@/components/readiness-panel";
import { RoutinesPanel } from "@/components/routines-panel";
import { SkillsPanel } from "@/components/skills-panel";
import { consoleQueryKeys, createConsoleQueryClient } from "@/lib/console-queries";
import { createOperatorApi, type OperatorApi } from "@/lib/operator-api";
import { toOperatorProblem } from "@/lib/schemas";

const styles = stylex.create({
  shell: {
    display: "flex",
    minHeight: "100vh",
    flexDirection: {
      default: "column",
      "@media (min-width: 768px)": "row",
    },
    backgroundColor: colorVars["--color-background-body"],
    color: colorVars["--color-text-primary"],
  },
  contentColumn: {
    display: "flex",
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacingVars["--spacing-3"],
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colorVars["--color-border"],
    backgroundColor: colorVars["--color-background-card"],
    paddingInline: spacingVars["--spacing-5"],
    paddingBlock: spacingVars["--spacing-3"],
  },
  headerGroup: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacingVars["--spacing-2"],
  },
  actorLabel: {
    fontSize: textSizeVars["--font-size-sm"],
    color: colorVars["--color-text-secondary"],
  },
  actorControl: {
    fontFamily: typographyVars["--font-family-code"],
    fontSize: textSizeVars["--font-size-sm"],
  },
  statusBar: {
    minHeight: spacingVars["--spacing-6"],
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colorVars["--color-border"],
    backgroundColor: colorVars["--color-background-muted"],
    paddingInline: spacingVars["--spacing-5"],
    paddingBlock: spacingVars["--spacing-1"],
    fontSize: textSizeVars["--font-size-sm"],
    color: colorVars["--color-text-secondary"],
  },
  main: {
    marginInline: "auto",
    display: "flex",
    width: "100%",
    maxWidth: "72rem",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    flexDirection: "column",
    gap: spacingVars["--spacing-4"],
    paddingInline: spacingVars["--spacing-5"],
    paddingBlock: spacingVars["--spacing-5"],
  },
  iconSm: {
    width: "0.875rem",
    height: "0.875rem",
  },
  iconMd: {
    width: "1rem",
    height: "1rem",
  },
  iconLg: {
    width: "1.5rem",
    height: "1.5rem",
  },
});

export interface AppProps {
  readonly api?: OperatorApi;
  readonly fetcher?: typeof fetch;
  /** How often the selected bot's session list is fetched again while the tab is visible. */
  readonly sessionRefreshMs?: number;
}

const SESSION_REFRESH_MS = 5_000;
const ACTOR_STORAGE_KEY = "der:operatorActor";
const EMPTY_BOTS: readonly Bot[] = [];
const EMPTY_SESSIONS: readonly Session[] = [];
const EMPTY_ENGINES: readonly EngineReadiness[] = [];
const EMPTY_CAPABILITIES: readonly CapabilityDescriptor[] = [];

function loadStoredActor(): string {
  try {
    const value = window.localStorage.getItem(ACTOR_STORAGE_KEY)?.trim();
    return value && value.length > 0 ? value : "operator";
  } catch {
    return "operator";
  }
}

interface ConsoleShellProps {
  readonly api: OperatorApi;
  readonly fetcher?: typeof fetch;
  readonly sessionRefreshMs: number;
}

function ConsoleShell({ api, fetcher, sessionRefreshMs }: ConsoleShellProps) {
  const queryClient = useQueryClient();

  const [chosenBotId, setChosenBotId] = useState<string | null>(null);
  const [chosenSessionId, setChosenSessionId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("chat");
  const [actor, setActor] = useState<string>(loadStoredActor);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [dismissedErrorKey, setDismissedErrorKey] = useState<string | null>(null);

  const announce = useCallback((message: string) => {
    setStatusMessage(message);
  }, []);

  const healthQuery = useQuery({
    queryKey: consoleQueryKeys.health(),
    queryFn: ({ signal }) => api.getHealth(signal),
  });
  const enginesQuery = useQuery({
    queryKey: consoleQueryKeys.engines(),
    queryFn: ({ signal }) => api.listEngines(signal),
  });
  const capabilitiesQuery = useQuery({
    queryKey: consoleQueryKeys.capabilities(),
    queryFn: ({ signal }) => api.listCapabilities(signal),
  });
  const botsQuery = useQuery({
    queryKey: consoleQueryKeys.bots(),
    queryFn: ({ signal }) => api.listBots(signal),
  });

  const health = healthQuery.data ?? null;
  const engines = enginesQuery.data ?? EMPTY_ENGINES;
  const capabilities = capabilitiesQuery.data ?? EMPTY_CAPABILITIES;
  const bots = botsQuery.data ?? EMPTY_BOTS;

  const selectedBotId =
    chosenBotId !== null && bots.some((entry) => entry.id === chosenBotId)
      ? chosenBotId
      : (bots[0]?.id ?? null);

  const sessionsQuery = useQuery({
    queryKey:
      selectedBotId !== null
        ? consoleQueryKeys.sessions(selectedBotId)
        : (["console", "sessions", null] as const),
    queryFn: ({ signal }) => {
      if (selectedBotId === null) {
        return Promise.resolve<Session[]>([]);
      }
      return api.listSessions(selectedBotId, signal);
    },
    enabled: selectedBotId !== null,
    refetchInterval: sessionRefreshMs,
    refetchIntervalInBackground: false,
  });

  const sessions = selectedBotId !== null ? (sessionsQuery.data ?? EMPTY_SESSIONS) : EMPTY_SESSIONS;

  const selectedSessionId =
    chosenSessionId !== null && sessions.some((entry) => entry.id === chosenSessionId)
      ? chosenSessionId
      : (sessions[0]?.id ?? null);

  const loadingBootstrap =
    healthQuery.isFetching ||
    enginesQuery.isFetching ||
    capabilitiesQuery.isFetching ||
    botsQuery.isFetching;

  const activeError = useMemo(() => {
    if (healthQuery.error) {
      return {
        key: `health:${healthQuery.errorUpdatedAt}`,
        problem: toOperatorProblem(healthQuery.error, "/healthz"),
      };
    }
    if (enginesQuery.error) {
      return {
        key: `engines:${enginesQuery.errorUpdatedAt}`,
        problem: toOperatorProblem(enginesQuery.error, "/api/engines"),
      };
    }
    if (capabilitiesQuery.error) {
      return {
        key: `capabilities:${capabilitiesQuery.errorUpdatedAt}`,
        problem: toOperatorProblem(capabilitiesQuery.error, "/api/capabilities"),
      };
    }
    if (botsQuery.error) {
      return {
        key: `bots:${botsQuery.errorUpdatedAt}`,
        problem: toOperatorProblem(botsQuery.error, "/api/bots"),
      };
    }
    if (selectedBotId !== null && sessionsQuery.error) {
      return {
        key: `sessions:${selectedBotId}:${sessionsQuery.errorUpdatedAt}`,
        problem: toOperatorProblem(sessionsQuery.error, `/api/bots/${selectedBotId}/sessions`),
      };
    }
    return null;
  }, [
    botsQuery.error,
    botsQuery.errorUpdatedAt,
    capabilitiesQuery.error,
    capabilitiesQuery.errorUpdatedAt,
    enginesQuery.error,
    enginesQuery.errorUpdatedAt,
    healthQuery.error,
    healthQuery.errorUpdatedAt,
    selectedBotId,
    sessionsQuery.error,
    sessionsQuery.errorUpdatedAt,
  ]);

  const bootstrapProblem =
    activeError !== null && activeError.key !== dismissedErrorKey ? activeError.problem : null;

  const refreshBootstrap = useCallback(() => {
    setDismissedErrorKey(null);
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.health() }),
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.engines() }),
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.capabilities() }),
      queryClient.invalidateQueries({ queryKey: consoleQueryKeys.bots() }),
      ...(selectedBotId !== null
        ? [queryClient.invalidateQueries({ queryKey: consoleQueryKeys.sessions(selectedBotId) })]
        : []),
    ]);
  }, [queryClient, selectedBotId]);

  const invalidateSelectedBotSessions = useCallback(() => {
    if (selectedBotId === null) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: consoleQueryKeys.sessions(selectedBotId),
    });
  }, [queryClient, selectedBotId]);

  function handleSelectBot(botId: string) {
    setChosenBotId(botId);
    setChosenSessionId(null);
  }

  function handleActorChange(value: string) {
    setActor(value);
    try {
      window.localStorage.setItem(ACTOR_STORAGE_KEY, value);
    } catch {
      // Ignore storage errors.
    }
  }

  function handleBotSaved(saved: Bot) {
    setChosenBotId(saved.id);
  }

  function handleSessionCreated(created: Session) {
    if (created.botId === selectedBotId) {
      setChosenSessionId(created.id);
      setActiveTab("chat");
    }
  }

  const selectedBot = bots.find((entry) => entry.id === selectedBotId) ?? null;
  const selectedSession = sessions.find((entry) => entry.id === selectedSessionId) ?? null;
  const readyEngineCount = engines.filter(
    (entry) => entry.interactive === "ready" && entry.isolationVerified,
  ).length;

  return (
    <Theme theme={neutralTheme}>
      <div {...stylex.props(styles.shell)}>
        <OperatorSidebar
          api={api}
          bots={bots}
          sessions={sessions}
          selectedBotId={selectedBotId}
          selectedSessionId={selectedSessionId}
          onSelectBot={handleSelectBot}
          onSelectSession={setChosenSessionId}
          onBotSaved={handleBotSaved}
          onSessionCreated={handleSessionCreated}
          onAnnounce={announce}
        />

        <div {...stylex.props(styles.contentColumn)}>
          <header {...stylex.props(styles.header)}>
            <div {...stylex.props(styles.headerGroup)}>
              <Heading level={1}>{selectedBot ? selectedBot.name : "der control plane"}</Heading>
              <Badge
                variant={health?.status === "ok" ? "success" : "error"}
                label={health?.status === "ok" ? "API healthy" : "API unreachable"}
              />
              <Badge
                variant={readyEngineCount > 0 ? "success" : "warning"}
                label={`${readyEngineCount}/${engines.length} engines ready`}
              />
            </div>

            <div {...stylex.props(styles.headerGroup)}>
              <label htmlFor="operator-actor-input" {...stylex.props(styles.actorLabel)}>
                Actor
              </label>
              <TextInput
                id="operator-actor-input"
                label="Operator actor identifier"
                isLabelHidden
                size="sm"
                width={128}
                value={actor}
                onChange={handleActorChange}
                controlXstyle={styles.actorControl}
              />
              <Button
                size="sm"
                variant="secondary"
                label="Refresh"
                icon={<RefreshCwIcon {...stylex.props(styles.iconSm)} aria-hidden="true" />}
                isDisabled={loadingBootstrap}
                onClick={refreshBootstrap}
              />
            </div>
          </header>

          <div
            role="status"
            aria-label="Operator status"
            aria-live="polite"
            {...stylex.props(styles.statusBar)}
          >
            {statusMessage || "Connected to same-origin der operator API."}
          </div>

          <main {...stylex.props(styles.main)}>
            {bootstrapProblem ? (
              <ProblemAlert
                problem={bootstrapProblem}
                onDismiss={() => setDismissedErrorKey(activeError?.key ?? null)}
                onRetry={refreshBootstrap}
              />
            ) : null}

            <TabList
              role="tablist"
              aria-label="Operator workspace sections"
              value={activeTab}
              onChange={setActiveTab}
              hasDivider
            >
              <Tab
                value="chat"
                label="Chat & Runs"
                panelId="panel-chat"
                icon={<MessageSquareIcon {...stylex.props(styles.iconMd)} aria-hidden="true" />}
              />
              <Tab
                value="memory"
                label="Memory"
                panelId="panel-memory"
                icon={<BrainIcon {...stylex.props(styles.iconMd)} aria-hidden="true" />}
              />
              <Tab
                value="routines"
                label="Routines"
                panelId="panel-routines"
                icon={<CalendarClockIcon {...stylex.props(styles.iconMd)} aria-hidden="true" />}
              />
              <Tab
                value="readiness"
                label="Readiness"
                panelId="panel-readiness"
                icon={<ActivityIcon {...stylex.props(styles.iconMd)} aria-hidden="true" />}
              />
              <Tab
                value="skills"
                label="Skills"
                panelId="panel-skills"
                icon={<BookOpenIcon {...stylex.props(styles.iconMd)} aria-hidden="true" />}
              />
            </TabList>

            <div role="tabpanel" id={`panel-${activeTab}`}>
              {activeTab === "chat" ? (
                selectedBot && selectedSession ? (
                  <ChatWorkspace
                    key={selectedSession.id}
                    api={api}
                    {...(fetcher !== undefined ? { fetcher } : {})}
                    bot={selectedBot}
                    session={selectedSession}
                    actor={actor}
                    onAnnounce={announce}
                    onRunActivity={invalidateSelectedBotSessions}
                  />
                ) : (
                  <EmptyState
                    icon={<MessageSquareIcon {...stylex.props(styles.iconLg)} aria-hidden="true" />}
                    title="Select a bot and session"
                    description="Create or choose a bot and session in the sidebar to inspect scoped history and run live prompts."
                  />
                )
              ) : activeTab === "memory" ? (
                <MemoryPanel api={api} bot={selectedBot} onAnnounce={announce} />
              ) : activeTab === "routines" ? (
                <RoutinesPanel
                  api={api}
                  bot={selectedBot}
                  sessions={sessions}
                  onAnnounce={announce}
                />
              ) : activeTab === "readiness" ? (
                <ReadinessPanel
                  health={health}
                  engines={engines}
                  capabilities={capabilities}
                  loading={loadingBootstrap}
                  problem={bootstrapProblem}
                  onRefresh={refreshBootstrap}
                />
              ) : (
                <SkillsPanel api={api} />
              )}
            </div>
          </main>
        </div>
      </div>
    </Theme>
  );
}

export function App({
  api: providedApi,
  fetcher,
  sessionRefreshMs = SESSION_REFRESH_MS,
}: AppProps) {
  const api = useMemo(
    () => providedApi ?? createOperatorApi(fetcher ? { fetcher } : {}),
    [providedApi, fetcher],
  );
  const [queryClient] = useState(createConsoleQueryClient);

  useEffect(() => () => queryClient.clear(), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <ConsoleShell
        api={api}
        {...(fetcher !== undefined ? { fetcher } : {})}
        sessionRefreshMs={sessionRefreshMs}
      />
    </QueryClientProvider>
  );
}
