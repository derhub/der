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
import {
  ActivityIcon,
  BookOpenIcon,
  BrainIcon,
  CalendarClockIcon,
  MessageSquareIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Bot,
  CapabilityDescriptor,
  EngineReadiness,
  ProblemDetails,
  Session,
} from "@der/domain";
import { ChatWorkspace } from "@/components/chat-workspace";
import { MemoryPanel } from "@/components/memory-panel";
import { OperatorSidebar } from "@/components/operator-sidebar";
import { ProblemAlert } from "@/components/problem-alert";
import { ReadinessPanel } from "@/components/readiness-panel";
import { RoutinesPanel } from "@/components/routines-panel";
import { SkillsPanel } from "@/components/skills-panel";
import { createOperatorApi, type OperatorApi } from "@/lib/operator-api";
import { toOperatorProblem, type HealthResponse } from "@/lib/schemas";

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
}

const ACTOR_STORAGE_KEY = "der:operatorActor";

function loadStoredActor(): string {
  try {
    const value = window.localStorage.getItem(ACTOR_STORAGE_KEY)?.trim();
    return value && value.length > 0 ? value : "operator";
  } catch {
    return "operator";
  }
}

export function App({ api: providedApi, fetcher }: AppProps) {
  const api = useMemo(
    () => providedApi ?? createOperatorApi(fetcher ? { fetcher } : {}),
    [providedApi, fetcher],
  );

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [engines, setEngines] = useState<EngineReadiness[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilityDescriptor[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("chat");
  const [actor, setActor] = useState<string>(loadStoredActor);
  const [loadingBootstrap, setLoadingBootstrap] = useState(false);
  const [bootstrapProblem, setBootstrapProblem] = useState<ProblemDetails | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");

  const announce = useCallback((message: string) => {
    setStatusMessage(message);
  }, []);

  const loadBootstrap = useCallback(async () => {
    setLoadingBootstrap(true);
    setBootstrapProblem(null);
    try {
      const [nextHealth, nextEngines, nextCapabilities, nextBots] = await Promise.all([
        api.getHealth(),
        api.listEngines(),
        api.listCapabilities(),
        api.listBots(),
      ]);
      setHealth(nextHealth);
      setEngines(nextEngines);
      setCapabilities(nextCapabilities);
      setBots(nextBots);
      setSelectedBotId((current) => {
        if (current && nextBots.some((entry) => entry.id === current)) {
          return current;
        }
        return nextBots[0]?.id ?? null;
      });
    } catch (error) {
      setBootstrapProblem(toOperatorProblem(error, "/api/bots"));
    } finally {
      setLoadingBootstrap(false);
    }
  }, [api]);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    if (!selectedBotId) {
      setSessions([]);
      setSelectedSessionId(null);
      return;
    }
    const controller = new AbortController();
    api
      .listSessions(selectedBotId, controller.signal)
      .then((loaded) => {
        setSessions(loaded);
        setSelectedSessionId((current) => {
          if (current && loaded.some((entry) => entry.id === current)) {
            return current;
          }
          return loaded[0]?.id ?? null;
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setBootstrapProblem(toOperatorProblem(error, `/api/bots/${selectedBotId}/sessions`));
        }
      });
    return () => controller.abort();
  }, [api, selectedBotId]);

  function handleActorChange(value: string) {
    setActor(value);
    try {
      window.localStorage.setItem(ACTOR_STORAGE_KEY, value);
    } catch {
      // Ignore storage errors.
    }
  }

  function handleBotSaved(saved: Bot) {
    setBots((prev) => {
      const exists = prev.some((entry) => entry.id === saved.id);
      return exists
        ? prev.map((entry) => (entry.id === saved.id ? saved : entry))
        : [...prev, saved];
    });
    setSelectedBotId(saved.id);
  }

  function handleSessionCreated(created: Session) {
    setSessions((prev) => [...prev, created]);
    setSelectedSessionId(created.id);
    setActiveTab("chat");
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
          onSelectBot={setSelectedBotId}
          onSelectSession={setSelectedSessionId}
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
                onClick={() => void loadBootstrap()}
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
                onDismiss={() => setBootstrapProblem(null)}
                onRetry={() => void loadBootstrap()}
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
                  onRefresh={() => void loadBootstrap()}
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
