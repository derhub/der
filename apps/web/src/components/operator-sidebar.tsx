import { BotIcon, MessageSquareIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Bot, EngineKind, ProblemDetails, Session } from "@der/domain";
import { ProblemAlert } from "@/components/problem-alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type { OperatorApi } from "@/lib/operator-api";
import { toOperatorProblem } from "@/lib/schemas";
import { cn } from "@/lib/utils";

const ALL_ENGINES: readonly EngineKind[] = ["codex", "claude-code", "antigravity", "fixture"];

export interface OperatorSidebarProps {
  readonly api: OperatorApi;
  readonly bots: readonly Bot[];
  readonly sessions: readonly Session[];
  readonly selectedBotId: string | null;
  readonly selectedSessionId: string | null;
  readonly onSelectBot: (botId: string) => void;
  readonly onSelectSession: (sessionId: string) => void;
  readonly onBotSaved: (bot: Bot) => void;
  readonly onSessionCreated: (session: Session) => void;
  readonly onAnnounce: (message: string) => void;
}

export function OperatorSidebar({
  api,
  bots,
  sessions,
  selectedBotId,
  selectedSessionId,
  onSelectBot,
  onSelectSession,
  onBotSaved,
  onSessionCreated,
  onAnnounce,
}: OperatorSidebarProps) {
  const [botDialogOpen, setBotDialogOpen] = useState(false);
  const [editingBot, setEditingBot] = useState<Bot | null>(null);
  const [botName, setBotName] = useState("");
  const [botPersona, setBotPersona] = useState("");
  const [botDefaultEngine, setBotDefaultEngine] = useState<EngineKind>("fixture");
  const [botAllowedEngines, setBotAllowedEngines] = useState<EngineKind[]>(["fixture"]);
  const [botWorkspacePath, setBotWorkspacePath] = useState("");
  const [botSaving, setBotSaving] = useState(false);
  const [botProblem, setBotProblem] = useState<ProblemDetails | null>(null);

  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [sessionTitle, setSessionTitle] = useState("");
  const [sessionEngine, setSessionEngine] = useState<string>("default");
  const [sessionSaving, setSessionSaving] = useState(false);
  const [sessionProblem, setSessionProblem] = useState<ProblemDetails | null>(null);

  const selectedBot = bots.find((entry) => entry.id === selectedBotId) ?? null;

  function openCreateBot() {
    setEditingBot(null);
    setBotName("");
    setBotPersona("");
    setBotDefaultEngine("fixture");
    setBotAllowedEngines(["fixture"]);
    setBotWorkspacePath("");
    setBotProblem(null);
    setBotDialogOpen(true);
  }

  function openEditBot(target: Bot) {
    setEditingBot(target);
    setBotName(target.name);
    setBotPersona(target.persona);
    setBotDefaultEngine(target.defaultEngine);
    setBotAllowedEngines([...target.allowedEngines]);
    setBotWorkspacePath(target.workspacePath ?? "");
    setBotProblem(null);
    setBotDialogOpen(true);
  }

  function toggleAllowedEngine(kind: EngineKind) {
    setBotAllowedEngines((prev) => {
      if (prev.includes(kind)) {
        if (prev.length === 1) {
          return prev;
        }
        const next = prev.filter((item) => item !== kind);
        if (botDefaultEngine === kind && next[0]) {
          setBotDefaultEngine(next[0]);
        }
        return next;
      }
      return [...prev, kind];
    });
  }

  async function handleBotSubmit(event: FormEvent) {
    event.preventDefault();
    if (botName.trim().length === 0) {
      return;
    }
    setBotSaving(true);
    setBotProblem(null);
    try {
      const allowed = botAllowedEngines.includes(botDefaultEngine)
        ? botAllowedEngines
        : [...botAllowedEngines, botDefaultEngine];
      const trimmedWorkspace = botWorkspacePath.trim();
      const saved = editingBot
        ? await api.updateBot(editingBot.id, {
            name: botName.trim(),
            persona: botPersona,
            defaultEngine: botDefaultEngine,
            allowedEngines: allowed,
            ...(trimmedWorkspace.length > 0 ? { workspacePath: trimmedWorkspace } : {}),
          })
        : await api.createBot({
            name: botName.trim(),
            persona: botPersona,
            defaultEngine: botDefaultEngine,
            allowedEngines: allowed,
            ...(trimmedWorkspace.length > 0 ? { workspacePath: trimmedWorkspace } : {}),
          });
      onBotSaved(saved);
      onAnnounce(editingBot ? `Updated bot ${saved.name}.` : `Created bot ${saved.name}.`);
      setBotDialogOpen(false);
    } catch (error) {
      setBotProblem(
        toOperatorProblem(error, editingBot ? `/api/bots/${editingBot.id}` : "/api/bots"),
      );
    } finally {
      setBotSaving(false);
    }
  }

  function openCreateSession() {
    setSessionTitle("");
    setSessionEngine("default");
    setSessionProblem(null);
    setSessionDialogOpen(true);
  }

  async function handleSessionSubmit(event: FormEvent) {
    event.preventDefault();
    if (!selectedBot || sessionTitle.trim().length === 0) {
      return;
    }
    setSessionSaving(true);
    setSessionProblem(null);
    try {
      const created = await api.createSession(selectedBot.id, {
        title: sessionTitle.trim(),
        ...(sessionEngine !== "default" ? { engine: sessionEngine as EngineKind } : {}),
      });
      onSessionCreated(created);
      onAnnounce(`Created session ${created.title}.`);
      setSessionDialogOpen(false);
    } catch (error) {
      setSessionProblem(toOperatorProblem(error, `/api/bots/${selectedBot.id}/sessions`));
    } finally {
      setSessionSaving(false);
    }
  }

  return (
    <aside
      aria-label="Bots and sessions"
      className="flex h-full w-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:w-72 md:shrink-0"
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <img src="/der-mark.svg" alt="" className="size-7 rounded-md" />
          <div className="flex flex-col">
            <span className="text-sm font-semibold tracking-tight leading-none">der</span>
            <span className="text-[11px] text-muted-foreground">Operator console</span>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={openCreateBot}>
          <PlusIcon data-icon="inline-start" />
          New bot
        </Button>
      </div>

      <Separator />

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
        <section aria-labelledby="sidebar-bots-heading" className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <h2 id="sidebar-bots-heading" className="text-xs font-semibold text-muted-foreground">
              Bots ({bots.length})
            </h2>
          </div>

          {bots.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No bots yet. Create one to start a scoped session.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {bots.map((entry) => {
                const isSelected = entry.id === selectedBotId;
                return (
                  <li key={entry.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onSelectBot(entry.id)}
                      aria-current={isSelected ? "true" : undefined}
                      className={cn(
                        "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                        isSelected
                          ? "bg-card font-medium text-foreground shadow-2xs ring-1 ring-border"
                          : "text-foreground/85 hover:bg-card/60",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <BotIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                        <span className="truncate">{entry.name}</span>
                      </span>
                      <Badge variant="secondary" className="font-mono text-[10px]">
                        {entry.defaultEngine}
                      </Badge>
                    </button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 shrink-0"
                      aria-label={`Edit bot ${entry.name}`}
                      onClick={() => openEditBot(entry)}
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <Separator />

        <section aria-labelledby="sidebar-sessions-heading" className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <h2
              id="sidebar-sessions-heading"
              className="text-xs font-semibold text-muted-foreground"
            >
              Sessions ({sessions.length})
            </h2>
            <Button
              size="sm"
              variant="ghost"
              disabled={!selectedBot}
              onClick={openCreateSession}
              className="h-7 px-2 text-xs"
            >
              <PlusIcon data-icon="inline-start" />
              New session
            </Button>
          </div>

          {!selectedBot ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              Select a bot to inspect its sessions.
            </p>
          ) : sessions.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No sessions in {selectedBot.name}.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {sessions.map((entry) => {
                const isSelected = entry.id === selectedSessionId;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => onSelectSession(entry.id)}
                      aria-current={isSelected ? "true" : undefined}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                        isSelected
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-foreground/85 hover:bg-card/60",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <MessageSquareIcon className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">{entry.title}</span>
                      </span>
                      {entry.engine ? (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {entry.engine}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <Dialog open={botDialogOpen} onOpenChange={setBotDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingBot ? `Edit bot ${editingBot.name}` : "Create bot"}</DialogTitle>
            <DialogDescription>
              Configure persona, default engine, and allowed BYO engines for this bot scope.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleBotSubmit} className="flex flex-col gap-4">
            {botProblem ? (
              <ProblemAlert problem={botProblem} onDismiss={() => setBotProblem(null)} />
            ) : null}

            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="bot-name-input">Name</FieldLabel>
                <Input
                  id="bot-name-input"
                  value={botName}
                  onChange={(event) => setBotName(event.target.value)}
                  placeholder="Home Ops"
                  required
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="bot-persona-input">Persona</FieldLabel>
                <Textarea
                  id="bot-persona-input"
                  value={botPersona}
                  onChange={(event) => setBotPersona(event.target.value)}
                  placeholder="Direct, verification-first operator assistant."
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="bot-default-engine">Default engine</FieldLabel>
                <Select
                  value={botDefaultEngine}
                  onValueChange={(value) => {
                    const next = value as EngineKind;
                    setBotDefaultEngine(next);
                    if (!botAllowedEngines.includes(next)) {
                      setBotAllowedEngines((prev) => [...prev, next]);
                    }
                  }}
                >
                  <SelectTrigger id="bot-default-engine">
                    <SelectValue placeholder="Choose engine" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {ALL_ENGINES.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {kind}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <FieldSet>
                <FieldLegend>Allowed engines</FieldLegend>
                <FieldDescription>
                  Sessions and runs for this bot can only use checked engines.
                </FieldDescription>
                <div className="flex flex-wrap gap-2">
                  {ALL_ENGINES.map((kind) => {
                    const checked = botAllowedEngines.includes(kind);
                    return (
                      <label
                        key={kind}
                        className={cn(
                          "inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-mono",
                          checked
                            ? "border-primary bg-accent text-accent-foreground"
                            : "border-border bg-card",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleAllowedEngine(kind)}
                          className="accent-primary"
                        />
                        {kind}
                      </label>
                    );
                  })}
                </div>
              </FieldSet>

              <Field>
                <FieldLabel htmlFor="bot-workspace-input">Workspace path (optional)</FieldLabel>
                <Input
                  id="bot-workspace-input"
                  value={botWorkspacePath}
                  onChange={(event) => setBotWorkspacePath(event.target.value)}
                  placeholder="/data/workspaces/home-ops"
                  className="font-mono text-xs"
                />
              </Field>
            </FieldGroup>

            <DialogFooter>
              <Button variant="outline" onClick={() => setBotDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={botSaving || botName.trim().length === 0}>
                {botSaving ? "Saving..." : editingBot ? "Save changes" : "Create bot"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={sessionDialogOpen} onOpenChange={setSessionDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create session</DialogTitle>
            <DialogDescription>
              Start a new scoped message history under {selectedBot?.name ?? "the selected bot"}.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSessionSubmit} className="flex flex-col gap-4">
            {sessionProblem ? (
              <ProblemAlert problem={sessionProblem} onDismiss={() => setSessionProblem(null)} />
            ) : null}

            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="session-title-input">Title</FieldLabel>
                <Input
                  id="session-title-input"
                  value={sessionTitle}
                  onChange={(event) => setSessionTitle(event.target.value)}
                  placeholder="Evening maintenance"
                  required
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="session-engine-select">Engine override</FieldLabel>
                <Select value={sessionEngine} onValueChange={setSessionEngine}>
                  <SelectTrigger id="session-engine-select">
                    <SelectValue placeholder="Bot default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="default">
                        Bot default ({selectedBot?.defaultEngine ?? "fixture"})
                      </SelectItem>
                      {(selectedBot?.allowedEngines ?? ALL_ENGINES).map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {kind}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>

            <DialogFooter>
              <Button variant="outline" onClick={() => setSessionDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={sessionSaving || sessionTitle.trim().length === 0}>
                {sessionSaving ? "Creating..." : "Create session"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
