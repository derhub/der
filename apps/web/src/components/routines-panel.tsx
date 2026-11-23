import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { CalendarClockIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Bot, EngineKind, ProblemDetails, Routine, Session } from "@der/domain";
import { ProblemAlert } from "@/components/problem-alert";
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
): BadgeVariant {
  if (disposition === "completed" || disposition === "admitted") return "success";
  if (
    disposition === "failed" ||
    disposition === "interrupted" ||
    disposition === "blocked_ineligible"
  ) {
    return "error";
  }
  if (disposition === "skipped_active_run") return "warning";
  return "neutral";
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
      <EmptyState
        icon={<CalendarClockIcon className="size-6" aria-hidden="true" />}
        title="No bot selected"
        description="Select a bot to inspect and configure its UTC Routines."
      />
    );
  }

  const sessionOptions = sessions.map((entry) => ({
    value: entry.id,
    label: entry.title,
  }));

  const engineOptions = bot.allowedEngines.map((kind) => ({
    value: kind,
    label: kind,
  }));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <Heading level={2}>Routines for {bot.name}</Heading>
          <Text type="supporting" as="p">
            Durable UTC cron schedules backed by Restate Virtual Objects and unattended engine
            checks.
          </Text>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            label="Refresh"
            icon={<RefreshCwIcon className="size-3.5" aria-hidden="true" />}
            isDisabled={loading}
            onClick={() => void loadRoutines(bot.id)}
          />
          <Button
            variant="primary"
            size="sm"
            label="New routine"
            icon={<PlusIcon className="size-3.5" aria-hidden="true" />}
            isDisabled={sessions.length === 0}
            onClick={openCreateDialog}
          />
        </div>
      </div>

      {problem ? <ProblemAlert problem={problem} onDismiss={() => setProblem(null)} /> : null}

      {routines.length === 0 ? (
        <EmptyState
          icon={<CalendarClockIcon className="size-6" aria-hidden="true" />}
          title="No routines scheduled"
          description={
            sessions.length === 0
              ? "Create a session first, then schedule a UTC routine against it."
              : "Schedule a recurring UTC prompt for an unattended-eligible engine."
          }
          actions={
            sessions.length > 0 ? (
              <Button
                variant="primary"
                size="sm"
                label="New routine"
                icon={<PlusIcon className="size-3.5" aria-hidden="true" />}
                onClick={openCreateDialog}
              />
            ) : undefined
          }
        />
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
                    isSelected ? "border-border-strong bg-accent-muted" : "border-border bg-card",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setSelectedRoutineId(entry.id)}
                      className="flex flex-col items-start gap-0.5 text-left focus-visible:outline-2 focus-visible:outline-info"
                    >
                      <span className="text-sm font-semibold">{entry.name}</span>
                      <span className="font-mono text-xs text-secondary">{entry.cron} UTC</span>
                    </button>
                    <Switch
                      label={`Toggle routine ${entry.name}`}
                      isLabelHidden
                      size="sm"
                      value={entry.enabled}
                      isDisabled={togglingId === entry.id}
                      onChange={(checked) => void handleToggle(entry, checked)}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge
                      variant={entry.enabled ? "success" : "neutral"}
                      label={entry.enabled ? "Enabled" : "Paused"}
                    />
                    <Badge variant="neutral" label={entry.engine} />
                    <Badge variant="neutral" label={`rev ${entry.revision}`} />
                  </div>
                </li>
              );
            })}
          </ul>

          <Card>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <Heading level={3}>{detail?.routine.name ?? "Routine detail"}</Heading>
                <Text type="code" color="secondary" as="p">
                  {detail
                    ? `${detail.routine.cron} UTC · session ${detail.routine.sessionId} · rev ${detail.routine.revision}`
                    : "Select a routine to inspect its prompt and recorded UTC slots."}
                </Text>
              </div>

              {detail ? (
                <>
                  <div className="flex flex-col gap-1">
                    <Text type="label" color="secondary">
                      Prompt
                    </Text>
                    <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm leading-relaxed">
                      {detail.routine.prompt}
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Text type="label" color="secondary">
                      Recorded UTC slots ({detail.slots.length})
                    </Text>
                    {detail.slots.length === 0 ? (
                      <Text type="supporting" as="p">
                        No UTC slots have fired yet for this routine.
                      </Text>
                    ) : (
                      <ul className="flex flex-col gap-1.5">
                        {detail.slots.map((slot) => (
                          <li
                            key={`${slot.slot}:${slot.revision}`}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs"
                          >
                            <span className="font-mono">{slot.slot}</span>
                            <div className="flex items-center gap-2">
                              <Badge
                                variant={dispositionBadgeVariant(slot.disposition)}
                                label={slot.disposition}
                              />
                              {slot.runId ? (
                                <span className="font-mono text-xs text-secondary">
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
            </div>
          </Card>
        </div>
      )}

      <Dialog isOpen={createOpen} onOpenChange={setCreateOpen} purpose="form" width={480}>
        <form onSubmit={handleCreate}>
          <Layout
            height="auto"
            header={
              <DialogHeader
                title="Create UTC routine"
                subtitle="Enabled routines verify unattended engine eligibility before scheduling."
                onOpenChange={setCreateOpen}
                hasDivider
              />
            }
            content={
              <LayoutContent isScrollable={false}>
                <div className="flex flex-col gap-4">
                  {formProblem ? (
                    <ProblemAlert problem={formProblem} onDismiss={() => setFormProblem(null)} />
                  ) : null}

                  <TextInput
                    id="routine-name-input"
                    label="Name"
                    value={name}
                    onChange={setName}
                    placeholder="Morning check"
                    isRequired
                    width="100%"
                  />

                  <Selector
                    id="routine-session-select"
                    label="Target session"
                    value={sessionId}
                    options={sessionOptions}
                    onChange={setSessionId}
                    placeholder="Choose session"
                    width="100%"
                  />

                  <TextInput
                    id="routine-cron-input"
                    label="UTC cron expression"
                    description="Evaluated strictly in UTC."
                    value={cron}
                    onChange={setCron}
                    placeholder="0 8 * * *"
                    isRequired
                    width="100%"
                    controlClassName="font-mono text-xs"
                  />

                  <Selector
                    id="routine-engine-select"
                    label="Engine"
                    value={engine}
                    options={engineOptions}
                    onChange={(value) => setEngine(value as EngineKind)}
                    placeholder="Choose engine"
                    width="100%"
                  />

                  <Switch
                    id="routine-enabled-switch"
                    label="Enable schedule immediately"
                    labelPosition="start"
                    labelSpacing="spread"
                    value={enabled}
                    onChange={setEnabled}
                    width="100%"
                  />

                  <TextArea
                    id="routine-prompt-input"
                    label="Prompt"
                    value={prompt}
                    onChange={setPrompt}
                    placeholder="Summarize overnight sensor alerts."
                    isRequired
                    width="100%"
                  />
                </div>
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" label="Cancel" onClick={() => setCreateOpen(false)} />
                  <Button
                    type="submit"
                    variant="primary"
                    label={saving ? "Scheduling..." : "Create routine"}
                    isDisabled={saving || name.trim().length === 0 || prompt.trim().length === 0}
                  />
                </div>
              </LayoutFooter>
            }
          />
        </form>
      </Dialog>
    </div>
  );
}
