import { CalendarClockIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Bot, EngineKind, ProblemDetails, Routine, Session } from "@der/domain";
import { ProblemAlert } from "@/components/problem-alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { OperatorApi } from "@/lib/operator-api";
import { toOperatorProblem, type RoutineDetailResponse } from "@/lib/schemas";
import { cn } from "@/lib/utils";

export interface RoutinesPanelProps {
  readonly api: OperatorApi;
  readonly bot: Bot | null;
  readonly sessions: readonly Session[];
  readonly onAnnounce: (message: string) => void;
}

function dispositionBadgeVariant(
  disposition: RoutineDetailResponse["slots"][number]["disposition"],
): "ready" | "warn" | "danger" | "secondary" {
  if (disposition === "completed" || disposition === "admitted") return "ready";
  if (
    disposition === "failed" ||
    disposition === "interrupted" ||
    disposition === "blocked_ineligible"
  ) {
    return "danger";
  }
  if (disposition === "skipped_active_run") return "warn";
  return "secondary";
}

export function RoutinesPanel({ api, bot, sessions, onAnnounce }: RoutinesPanelProps) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RoutineDetailResponse | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [cron, setCron] = useState("0 * * * *");
  const [engine, setEngine] = useState<EngineKind>("fixture");
  const [enabled, setEnabled] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [formProblem, setFormProblem] = useState<ProblemDetails | null>(null);

  const loadRoutines = useCallback(
    async (botId: string) => {
      setLoading(true);
      setProblem(null);
      try {
        const list = await api.listRoutines(botId);
        setRoutines(list);
        setSelectedRoutineId((current) => {
          if (current && list.some((entry) => entry.id === current)) {
            return current;
          }
          return list[0]?.id ?? null;
        });
      } catch (error) {
        setProblem(toOperatorProblem(error, `/api/bots/${botId}/routines`));
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (!bot) {
      setRoutines([]);
      setSelectedRoutineId(null);
      setDetail(null);
      return;
    }
    void loadRoutines(bot.id);
  }, [bot, loadRoutines]);

  useEffect(() => {
    if (!selectedRoutineId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    api
      .getRoutine(selectedRoutineId, controller.signal)
      .then((loaded) => setDetail(loaded))
      .catch((error) => {
        if (!controller.signal.aborted) {
          setProblem(toOperatorProblem(error, `/api/routines/${selectedRoutineId}`));
        }
      });
    return () => controller.abort();
  }, [api, selectedRoutineId]);

  function openCreateDialog() {
    if (!bot) return;
    setName("");
    setSessionId(sessions[0]?.id ?? "");
    setCron("0 * * * *");
    setEngine(bot.defaultEngine);
    setEnabled(true);
    setPrompt("");
    setFormProblem(null);
    setCreateOpen(true);
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    if (!bot || !sessionId || name.trim().length === 0 || prompt.trim().length === 0) {
      return;
    }
    setSaving(true);
    setFormProblem(null);
    try {
      const configured = await api.createRoutine(bot.id, {
        sessionId,
        name: name.trim(),
        cron: cron.trim(),
        enabled,
        engine,
        prompt: prompt.trim(),
      });
      await loadRoutines(bot.id);
      setSelectedRoutineId(configured.routine.id);
      setCreateOpen(false);
      onAnnounce(`Created routine ${configured.routine.name}.`);
    } catch (error) {
      setFormProblem(toOperatorProblem(error, `/api/bots/${bot.id}/routines`));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(target: Routine, nextEnabled: boolean) {
    setTogglingId(target.id);
    setProblem(null);
    try {
      const configured = await api.updateRoutine(target.id, {
        enabled: nextEnabled,
        expectedRevision: target.revision,
      });
      setRoutines((prev) =>
        prev.map((entry) => (entry.id === target.id ? configured.routine : entry)),
      );
      if (selectedRoutineId === target.id) {
        const refreshed = await api.getRoutine(target.id);
        setDetail(refreshed);
      }
      onAnnounce(
        `${configured.routine.name} is now ${configured.routine.enabled ? "enabled" : "paused"}.`,
      );
    } catch (error) {
      setProblem(toOperatorProblem(error, `/api/routines/${target.id}`));
    } finally {
      setTogglingId(null);
    }
  }

  if (!bot) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia>
            <CalendarClockIcon />
          </EmptyMedia>
          <EmptyTitle>No bot selected</EmptyTitle>
          <EmptyDescription>
            Select a bot to inspect and configure its UTC Routines.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-base font-semibold tracking-tight">Routines for {bot.name}</h2>
          <p className="text-xs text-muted-foreground">
            Durable UTC cron schedules backed by Restate Virtual Objects and unattended engine
            checks.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadRoutines(bot.id)}
            disabled={loading}
          >
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
          <Button size="sm" onClick={openCreateDialog} disabled={sessions.length === 0}>
            <PlusIcon data-icon="inline-start" />
            New routine
          </Button>
        </div>
      </div>

      {problem ? <ProblemAlert problem={problem} onDismiss={() => setProblem(null)} /> : null}

      {routines.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia>
              <CalendarClockIcon />
            </EmptyMedia>
            <EmptyTitle>No routines scheduled</EmptyTitle>
            <EmptyDescription>
              {sessions.length === 0
                ? "Create a session first, then schedule a UTC routine against it."
                : "Schedule a recurring UTC prompt for an unattended-eligible engine."}
            </EmptyDescription>
          </EmptyHeader>
          {sessions.length > 0 ? (
            <EmptyContent>
              <Button size="sm" onClick={openCreateDialog}>
                <PlusIcon data-icon="inline-start" />
                New routine
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <ul className="flex flex-col gap-2" aria-label="Bot routines">
            {routines.map((entry) => {
              const isSelected = entry.id === selectedRoutineId;
              return (
                <li
                  key={entry.id}
                  className={cn(
                    "flex flex-col gap-2.5 rounded-lg border p-3.5 transition-colors",
                    isSelected ? "border-primary bg-accent/50" : "border-border bg-card",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedRoutineId(entry.id)}
                      className="flex flex-col items-start gap-0.5 text-left focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <span className="text-sm font-semibold">{entry.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {entry.cron} UTC
                      </span>
                    </button>
                    <Switch
                      checked={entry.enabled}
                      disabled={togglingId === entry.id}
                      aria-label={`Toggle routine ${entry.name}`}
                      onCheckedChange={(checked) => void handleToggle(entry, checked)}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={entry.enabled ? "ready" : "secondary"}>
                      {entry.enabled ? "Enabled" : "Paused"}
                    </Badge>
                    <Badge variant="outline" className="font-mono">
                      {entry.engine}
                    </Badge>
                    <Badge variant="outline" className="font-mono">
                      rev {entry.revision}
                    </Badge>
                  </div>
                </li>
              );
            })}
          </ul>

          <Card>
            <CardHeader>
              <CardTitle>{detail?.routine.name ?? "Routine detail"}</CardTitle>
              <CardDescription className="font-mono text-xs">
                {detail
                  ? `${detail.routine.cron} UTC · session ${detail.routine.sessionId} · rev ${detail.routine.revision}`
                  : "Select a routine to inspect its prompt and recorded UTC slots."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {detail ? (
                <>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">Prompt</span>
                    <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm leading-relaxed">
                      {detail.routine.prompt}
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      Recorded UTC slots ({detail.slots.length})
                    </span>
                    {detail.slots.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No UTC slots have fired yet for this routine.
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-1.5">
                        {detail.slots.map((slot) => (
                          <li
                            key={`${slot.slot}:${slot.revision}`}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs"
                          >
                            <span className="font-mono">{slot.slot}</span>
                            <div className="flex items-center gap-2">
                              <Badge variant={dispositionBadgeVariant(slot.disposition)}>
                                {slot.disposition}
                              </Badge>
                              {slot.runId ? (
                                <span className="font-mono text-[11px] text-muted-foreground">
                                  run {slot.runId}
                                </span>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              ) : null}
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create UTC routine</DialogTitle>
            <DialogDescription>
              Enabled routines verify unattended engine eligibility before scheduling.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            {formProblem ? (
              <ProblemAlert problem={formProblem} onDismiss={() => setFormProblem(null)} />
            ) : null}

            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="routine-name-input">Name</FieldLabel>
                <Input
                  id="routine-name-input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Morning check"
                  required
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="routine-session-select">Target session</FieldLabel>
                <Select value={sessionId} onValueChange={setSessionId}>
                  <SelectTrigger id="routine-session-select">
                    <SelectValue placeholder="Choose session" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {sessions.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.title}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="routine-cron-input">UTC cron expression</FieldLabel>
                <Input
                  id="routine-cron-input"
                  value={cron}
                  onChange={(event) => setCron(event.target.value)}
                  placeholder="0 8 * * *"
                  className="font-mono text-xs"
                  required
                />
                <FieldDescription>Evaluated strictly in UTC.</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="routine-engine-select">Engine</FieldLabel>
                <Select value={engine} onValueChange={(v) => setEngine(v as EngineKind)}>
                  <SelectTrigger id="routine-engine-select">
                    <SelectValue placeholder="Choose engine" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {bot.allowedEngines.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {kind}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <Field orientation="horizontal">
                <FieldLabel htmlFor="routine-enabled-switch">
                  Enable schedule immediately
                </FieldLabel>
                <Switch
                  id="routine-enabled-switch"
                  checked={enabled}
                  onCheckedChange={setEnabled}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="routine-prompt-input">Prompt</FieldLabel>
                <Textarea
                  id="routine-prompt-input"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Summarize overnight sensor alerts."
                  required
                />
              </Field>
            </FieldGroup>

            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saving || name.trim().length === 0 || prompt.trim().length === 0}
              >
                {saving ? "Scheduling..." : "Create routine"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
