import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import {
  ActivityIcon,
  BookOpenIcon,
  BrainIcon,
  CalendarClockIcon,
  MessageSquareIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Bot, EngineReadiness, ProblemDetails, Session, ToolDescriptor } from "@der/domain";
import { ChatWorkspace } from "@/components/chat-workspace";
import { MemoryPanel } from "@/components/memory-panel";
import { OperatorSidebar } from "@/components/operator-sidebar";
import { ProblemAlert } from "@/components/problem-alert";
import { ReadinessPanel } from "@/components/readiness-panel";
import { RoutinesPanel } from "@/components/routines-panel";
import { SkillsPanel } from "@/components/skills-panel";
import { createOperatorApi, type OperatorApi } from "@/lib/operator-api";
import { toOperatorProblem, type HealthResponse } from "@/lib/schemas";

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
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
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
      const [nextHealth, nextEngines, nextTools, nextBots] = await Promise.all([
        api.getHealth(),
        api.listEngines(),
        api.listTools(),
        api.listBots(),
      ]);
      setHealth(nextHealth);
      setEngines(nextEngines);
      setTools(nextTools);
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
      <div className="flex min-h-screen flex-col bg-body text-primary md:flex-row">
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

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card px-5 py-3">
            <div className="flex flex-wrap items-center gap-2">
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

            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="operator-actor-input" className="text-xs text-secondary">
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
                controlClassName="font-mono text-xs"
              />
              <Button
                size="sm"
                variant="secondary"
                label="Refresh"
                icon={<RefreshCwIcon className="size-3.5" aria-hidden="true" />}
                isDisabled={loadingBootstrap}
                onClick={() => void loadBootstrap()}
              />
            </div>
          </header>

          <div
            role="status"
            aria-label="Operator status"
            aria-live="polite"
            className="min-h-6 border-b border-border bg-muted px-5 py-1 text-xs text-secondary"
          >
            {statusMessage || "Connected to same-origin der operator API."}
          </div>

          <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-5 py-5">
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
                icon={<MessageSquareIcon className="size-4" aria-hidden="true" />}
              />
              <Tab
                value="memory"
                label="Memory"
                panelId="panel-memory"
                icon={<BrainIcon className="size-4" aria-hidden="true" />}
              />
              <Tab
                value="routines"
                label="Routines"
                panelId="panel-routines"
                icon={<CalendarClockIcon className="size-4" aria-hidden="true" />}
              />
              <Tab
                value="readiness"
                label="Readiness"
                panelId="panel-readiness"
                icon={<ActivityIcon className="size-4" aria-hidden="true" />}
              />
              <Tab
                value="skills"
                label="Skills"
                panelId="panel-skills"
                icon={<BookOpenIcon className="size-4" aria-hidden="true" />}
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
                    icon={<MessageSquareIcon className="size-6" aria-hidden="true" />}
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
                  tools={tools}
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
