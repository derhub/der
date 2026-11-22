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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
    <div className="flex min-h-screen flex-col bg-background text-foreground md:flex-row">
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
            <h1 className="text-sm font-semibold tracking-tight">
              {selectedBot ? selectedBot.name : "der control plane"}
            </h1>
            <Badge variant={health?.status === "ok" ? "ready" : "danger"}>
              {health?.status === "ok" ? "API healthy" : "API unreachable"}
            </Badge>
            <Badge variant={readyEngineCount > 0 ? "ready" : "warn"}>
              {readyEngineCount}/{engines.length} engines ready
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="operator-actor-input" className="text-xs text-muted-foreground">
              Actor
            </label>
            <Input
              id="operator-actor-input"
              value={actor}
              onChange={(event) => handleActorChange(event.target.value)}
              className="h-8 w-32 font-mono text-xs"
              aria-label="Operator actor identifier"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={loadingBootstrap}
              onClick={() => void loadBootstrap()}
            >
              <RefreshCwIcon data-icon="inline-start" />
              Refresh
            </Button>
          </div>
        </header>

        <div
          role="status"
          aria-live="polite"
          className="min-h-6 border-b border-border/60 bg-muted/40 px-5 py-1 text-xs text-muted-foreground"
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

          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList aria-label="Operator workspace sections" className="flex-wrap h-auto">
              <TabsTrigger value="chat">
                <MessageSquareIcon aria-hidden="true" />
                Chat &amp; Runs
              </TabsTrigger>
              <TabsTrigger value="memory">
                <BrainIcon aria-hidden="true" />
                Memory
              </TabsTrigger>
              <TabsTrigger value="routines">
                <CalendarClockIcon aria-hidden="true" />
                Routines
              </TabsTrigger>
              <TabsTrigger value="readiness">
                <ActivityIcon aria-hidden="true" />
                Readiness
              </TabsTrigger>
              <TabsTrigger value="skills">
                <BookOpenIcon aria-hidden="true" />
                Skills
              </TabsTrigger>
            </TabsList>

            <TabsContent value="chat">
              {selectedBot && selectedSession ? (
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
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia>
                      <MessageSquareIcon />
                    </EmptyMedia>
                    <EmptyTitle>Select a bot and session</EmptyTitle>
                    <EmptyDescription>
                      Create or choose a bot and session in the sidebar to inspect scoped history
                      and run live prompts.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </TabsContent>

            <TabsContent value="memory">
              <MemoryPanel api={api} bot={selectedBot} onAnnounce={announce} />
            </TabsContent>

            <TabsContent value="routines">
              <RoutinesPanel
                api={api}
                bot={selectedBot}
                sessions={sessions}
                onAnnounce={announce}
              />
            </TabsContent>

            <TabsContent value="readiness">
              <ReadinessPanel
                health={health}
                engines={engines}
                tools={tools}
                loading={loadingBootstrap}
                problem={bootstrapProblem}
                onRefresh={() => void loadBootstrap()}
              />
            </TabsContent>

            <TabsContent value="skills">
              <SkillsPanel api={api} />
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </div>
  );
}
