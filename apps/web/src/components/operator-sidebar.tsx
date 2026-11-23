import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { BotIcon, MessageSquareIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { Bot, EngineKind, ProblemDetails, Session } from "@der/domain";
import { ProblemAlert } from "@/components/problem-alert";
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

  const allEngineOptions = ALL_ENGINES.map((kind) => ({ value: kind, label: kind }));
  const sessionEngineOptions = [
    { value: "default", label: `Bot default (${selectedBot?.defaultEngine ?? "fixture"})` },
    ...(selectedBot?.allowedEngines ?? ALL_ENGINES).map((kind) => ({
      value: kind,
      label: kind,
    })),
  ];

  return (
    <aside
      aria-label="Bots and sessions"
      className="flex h-full w-full flex-col border-r border-border bg-surface text-primary md:w-72 md:shrink-0"
    >
      <div className="flex items-center justify-between gap-2 px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <img src="/der-mark.svg" alt="" className="size-7 rounded-md" />
          <div className="flex flex-col">
            <span className="text-sm font-semibold tracking-tight leading-none">der</span>
            <Text type="supporting">Operator console</Text>
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          label="New bot"
          icon={<PlusIcon className="size-3.5" aria-hidden="true" />}
          onClick={openCreateBot}
        />
      </div>

      <Divider />

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
        <section aria-labelledby="sidebar-bots-heading" className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <Heading level={2} id="sidebar-bots-heading" color="secondary">
              Bots ({bots.length})
            </Heading>
          </div>

          {bots.length === 0 ? (
            <Text type="supporting" as="p" className="px-2 py-2">
              No bots yet. Create one to start a scoped session.
            </Text>
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
                        "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-info",
                        isSelected
                          ? "bg-card font-medium text-primary shadow-sm ring-1 ring-border"
                          : "text-secondary hover:bg-card/60 hover:text-primary",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <BotIcon className="size-4 shrink-0 text-accent" aria-hidden="true" />
                        <span className="truncate">{entry.name}</span>
                      </span>
                      <Badge variant="neutral" label={entry.defaultEngine} />
                    </button>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      label={`Edit bot ${entry.name}`}
                      icon={<PencilIcon className="size-3.5" aria-hidden="true" />}
                      onClick={() => openEditBot(entry)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <Divider />

        <section aria-labelledby="sidebar-sessions-heading" className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <Heading level={2} id="sidebar-sessions-heading" color="secondary">
              Sessions ({sessions.length})
            </Heading>
            <Button
              size="sm"
              variant="ghost"
              label="New session"
              icon={<PlusIcon className="size-3.5" aria-hidden="true" />}
              isDisabled={!selectedBot}
              onClick={openCreateSession}
            />
          </div>

          {!selectedBot ? (
            <Text type="supporting" as="p" className="px-2 py-2">
              Select a bot to inspect its sessions.
            </Text>
          ) : sessions.length === 0 ? (
            <Text type="supporting" as="p" className="px-2 py-2">
              No sessions in {selectedBot.name}.
            </Text>
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
                        "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-info",
                        isSelected
                          ? "bg-accent-muted font-medium text-primary"
                          : "text-secondary hover:bg-card/60 hover:text-primary",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <MessageSquareIcon className="size-3.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">{entry.title}</span>
                      </span>
                      {entry.engine ? (
                        <span className="font-mono text-xs text-secondary">{entry.engine}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <Dialog isOpen={botDialogOpen} onOpenChange={setBotDialogOpen} purpose="form" width={480}>
        <form onSubmit={handleBotSubmit}>
          <Layout
            height="auto"
            header={
              <DialogHeader
                title={editingBot ? `Edit bot ${editingBot.name}` : "Create bot"}
                subtitle="Configure persona, default engine, and allowed BYO engines for this bot scope."
                onOpenChange={setBotDialogOpen}
                hasDivider
              />
            }
            content={
              <LayoutContent isScrollable={false}>
                <div className="flex flex-col gap-4">
                  {botProblem ? (
                    <ProblemAlert problem={botProblem} onDismiss={() => setBotProblem(null)} />
                  ) : null}

                  <TextInput
                    id="bot-name-input"
                    label="Name"
                    value={botName}
                    onChange={setBotName}
                    placeholder="Home Ops"
                    isRequired
                    width="100%"
                  />

                  <TextArea
                    id="bot-persona-input"
                    label="Persona"
                    value={botPersona}
                    onChange={setBotPersona}
                    placeholder="Direct, verification-first operator assistant."
                    width="100%"
                  />

                  <Selector
                    id="bot-default-engine"
                    label="Default engine"
                    value={botDefaultEngine}
                    options={allEngineOptions}
                    onChange={(value) => {
                      const next = value as EngineKind;
                      setBotDefaultEngine(next);
                      if (!botAllowedEngines.includes(next)) {
                        setBotAllowedEngines((prev) => [...prev, next]);
                      }
                    }}
                    placeholder="Choose engine"
                    width="100%"
                  />

                  <fieldset className="flex flex-col gap-2">
                    <legend className="text-sm font-medium text-primary">Allowed engines</legend>
                    <Text type="supporting" as="p">
                      Sessions and runs for this bot can only use checked engines.
                    </Text>
                    <div className="flex flex-wrap gap-3">
                      {ALL_ENGINES.map((kind) => (
                        <CheckboxInput
                          key={kind}
                          label={kind}
                          size="sm"
                          value={botAllowedEngines.includes(kind)}
                          onChange={() => toggleAllowedEngine(kind)}
                        />
                      ))}
                    </div>
                  </fieldset>

                  <TextInput
                    id="bot-workspace-input"
                    label="Workspace path (optional)"
                    value={botWorkspacePath}
                    onChange={setBotWorkspacePath}
                    placeholder="/data/workspaces/home-ops"
                    width="100%"
                    controlClassName="font-mono text-xs"
                  />
                </div>
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="secondary"
                    label="Cancel"
                    onClick={() => setBotDialogOpen(false)}
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    label={botSaving ? "Saving..." : editingBot ? "Save changes" : "Create bot"}
                    isDisabled={botSaving || botName.trim().length === 0}
                  />
                </div>
              </LayoutFooter>
            }
          />
        </form>
      </Dialog>

      <Dialog
        isOpen={sessionDialogOpen}
        onOpenChange={setSessionDialogOpen}
        purpose="form"
        width={440}
      >
        <form onSubmit={handleSessionSubmit}>
          <Layout
            height="auto"
            header={
              <DialogHeader
                title="Create session"
                subtitle={`Start a new scoped message history under ${selectedBot?.name ?? "the selected bot"}.`}
                onOpenChange={setSessionDialogOpen}
                hasDivider
              />
            }
            content={
              <LayoutContent isScrollable={false}>
                <div className="flex flex-col gap-4">
                  {sessionProblem ? (
                    <ProblemAlert
                      problem={sessionProblem}
                      onDismiss={() => setSessionProblem(null)}
                    />
                  ) : null}

                  <TextInput
                    id="session-title-input"
                    label="Title"
                    value={sessionTitle}
                    onChange={setSessionTitle}
                    placeholder="Evening maintenance"
                    isRequired
                    width="100%"
                  />

                  <Selector
                    id="session-engine-select"
                    label="Engine override"
                    value={sessionEngine}
                    options={sessionEngineOptions}
                    onChange={setSessionEngine}
                    placeholder="Bot default"
                    width="100%"
                  />
                </div>
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="secondary"
                    label="Cancel"
                    onClick={() => setSessionDialogOpen(false)}
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    label={sessionSaving ? "Creating..." : "Create session"}
                    isDisabled={sessionSaving || sessionTitle.trim().length === 0}
                  />
                </div>
              </LayoutFooter>
            }
          />
        </form>
      </Dialog>
    </aside>
  );
}
