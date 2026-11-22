import {
  CheckIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  SendIcon,
  ShieldAlertIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  Approval,
  Bot,
  EngineKind,
  Message,
  ProblemDetails,
  Run,
  RunAdmission,
  Session,
} from "@der/domain";
import { useChat, type UIMessage } from "@tanstack/ai-react";
import { ProblemAlert } from "@/components/problem-alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
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
import { createIdempotencyTracker } from "@/lib/idempotency";
import type { OperatorApi } from "@/lib/operator-api";
import {
  createDerChatConnection,
  domainMessagesToUiMessages,
  streamRunEvents,
  type RunStreamStatus,
} from "@/lib/run-stream";
import { toOperatorProblem } from "@/lib/schemas";
import { cn } from "@/lib/utils";

interface PersistedRunCursor {
  readonly runId: string;
  readonly cursor: number;
}

interface FailedDraftRetry {
  readonly text: string;
  readonly engine: EngineKind;
  readonly idempotencyKey: string;
}

export interface ChatWorkspaceProps {
  readonly api: OperatorApi;
  readonly fetcher?: typeof fetch;
  readonly bot: Bot;
  readonly session: Session;
  readonly actor: string;
  readonly onAnnounce: (message: string) => void;
}

function cursorStorageKey(sessionId: string): string {
  return `der:activeRun:${sessionId}`;
}

function readPersistedCursor(sessionId: string): PersistedRunCursor | null {
  try {
    const raw = window.sessionStorage.getItem(cursorStorageKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { runId?: unknown; cursor?: unknown };
    if (
      typeof parsed.runId === "string" &&
      parsed.runId.length > 0 &&
      typeof parsed.cursor === "number" &&
      Number.isSafeInteger(parsed.cursor) &&
      parsed.cursor >= 0
    ) {
      return { runId: parsed.runId, cursor: parsed.cursor };
    }
    return null;
  } catch {
    return null;
  }
}

function writePersistedCursor(sessionId: string, state: PersistedRunCursor | null): void {
  try {
    if (state === null) {
      window.sessionStorage.removeItem(cursorStorageKey(sessionId));
    } else {
      window.sessionStorage.setItem(cursorStorageKey(sessionId), JSON.stringify(state));
    }
  } catch {
    // Ignore storage quota or restricted-mode errors.
  }
}

function runStatusBadgeVariant(
  status: Run["status"],
): "ready" | "warn" | "danger" | "secondary" | "default" {
  if (status === "completed") return "ready";
  if (status === "waiting_approval") return "warn";
  if (status === "failed" || status === "interrupted" || status === "cancelled") return "danger";
  if (status === "running") return "default";
  return "secondary";
}

function approvalBadgeVariant(status: Approval["decision"]["status"]): "ready" | "warn" | "danger" {
  if (status === "approved") return "ready";
  if (status === "pending") return "warn";
  return "danger";
}

function streamStatusLabel(status: RunStreamStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "connecting":
      return "Connecting";
    case "streaming":
      return "Streaming";
    case "reconnecting":
      return "Reconnecting";
    case "terminal_chunk":
      return "Completed";
    case "terminal_204":
      return "Settled (204)";
    case "error":
      return "Stream error";
  }
}

function renderMessagePart(part: UIMessage["parts"][number], index: number) {
  if (part.type === "text") {
    return (
      <p key={`text-${index}`} className="text-sm leading-relaxed whitespace-pre-wrap break-words">
        {part.content}
      </p>
    );
  }
  if (part.type === "tool-call") {
    return (
      <div
        key={`tc-${part.id}-${index}`}
        className="rounded-md border border-border bg-muted/60 px-3 py-2 font-mono text-xs"
      >
        <div className="font-semibold text-foreground">Tool call: {part.name}</div>
        <pre className="mt-1 overflow-x-auto text-[11px] text-muted-foreground whitespace-pre-wrap">
          {part.arguments}
        </pre>
      </div>
    );
  }
  if (part.type === "tool-result") {
    return (
      <div
        key={`tr-${part.toolCallId}-${index}`}
        className={cn(
          "rounded-md border px-3 py-2 font-mono text-xs",
          part.state === "error"
            ? "border-status-danger/30 bg-status-danger-surface text-status-danger"
            : "border-border bg-muted/40 text-foreground",
        )}
      >
        <div className="font-semibold">Tool result ({part.toolCallId})</div>
        <pre className="mt-1 overflow-x-auto text-[11px] whitespace-pre-wrap">
          {typeof part.content === "string" ? part.content : JSON.stringify(part.content, null, 2)}
        </pre>
      </div>
    );
  }
  if (part.type === "thinking") {
    return (
      <div
        key={`think-${index}`}
        className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground italic whitespace-pre-wrap"
      >
        {part.content}
      </div>
    );
  }
  return null;
}

export function ChatWorkspace({
  api,
  fetcher,
  bot,
  session,
  actor,
  onAnnounce,
}: ChatWorkspaceProps) {
  const defaultEngine: EngineKind = session.engine ?? bot.defaultEngine;
  const [selectedEngine, setSelectedEngine] = useState<EngineKind>(defaultEngine);
  const [draft, setDraft] = useState("");
  const [historyMessages, setHistoryMessages] = useState<Message[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const [activeApproval, setActiveApproval] = useState<Approval | null>(null);
  const [streamStatus, setStreamStatus] = useState<RunStreamStatus>("idle");
  const [committedCursor, setCommittedCursor] = useState(0);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [failedDraft, setFailedDraft] = useState<FailedDraftRetry | null>(null);
  const [decidingApproval, setDecidingApproval] = useState(false);
  const [resumingStream, setResumingStream] = useState(false);

  const idempotencyTrackerRef = useRef(createIdempotencyTracker());
  const cursorMapRef = useRef<Map<string, number>>(new Map());
  const resumeAbortRef = useRef<AbortController | null>(null);
  const setChatMessagesRef = useRef<((msgs: ReadonlyArray<UIMessage>) => void) | null>(null);

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const loaded = await api.listMessages(session.id, { limit: 100 });
      setHistoryMessages(loaded);
      setChatMessagesRef.current?.(domainMessagesToUiMessages(loaded));
    } catch (error) {
      setProblem(toOperatorProblem(error, `/api/sessions/${session.id}/messages`));
    } finally {
      setHistoryLoading(false);
    }
  }, [api, session.id]);

  const refreshRunState = useCallback(
    async (runId: string) => {
      try {
        const detail = await api.getRun(runId);
        setActiveRun(detail.run);
        setActiveApproval(detail.approval);
        if (
          detail.run.status === "completed" ||
          detail.run.status === "failed" ||
          detail.run.status === "interrupted" ||
          detail.run.status === "cancelled"
        ) {
          writePersistedCursor(session.id, null);
        }
      } catch (error) {
        setProblem(toOperatorProblem(error, `/api/runs/${runId}`));
      }
    },
    [api, session.id],
  );

  const handleRunAdmitted = useCallback(
    (admission: RunAdmission) => {
      idempotencyTrackerRef.current.clear(session.id);
      setFailedDraft(null);
      setProblem(null);
      setActiveRun(admission.run);
      setActiveApproval(null);
      setCommittedCursor(0);
      cursorMapRef.current.set(admission.run.id, 0);
      writePersistedCursor(session.id, { runId: admission.run.id, cursor: 0 });
      onAnnounce(
        admission.isDuplicate
          ? `Resumed existing run ${admission.run.id}.`
          : `Started run ${admission.run.id}.`,
      );
    },
    [onAnnounce, session.id],
  );

  const handleCursorAdvance = useCallback(
    (runId: string, sequence: number) => {
      cursorMapRef.current.set(runId, sequence);
      setCommittedCursor(sequence);
      writePersistedCursor(session.id, { runId, cursor: sequence });
    },
    [session.id],
  );

  const handleStreamStatus = useCallback((_runId: string, status: RunStreamStatus) => {
    setStreamStatus(status);
  }, []);

  const handleApprovalSignal = useCallback(
    (eventName: string, _payload: unknown, runId: string) => {
      void refreshRunState(runId);
      if (eventName === "approval.requested") {
        onAnnounce(`Approval required for run ${runId}.`);
      }
    },
    [onAnnounce, refreshRunState],
  );

  const handleRunSettled = useCallback(
    (runId: string) => {
      void refreshRunState(runId);
      void refreshHistory();
    },
    [refreshHistory, refreshRunState],
  );

  const connection = useMemo(
    () =>
      createDerChatConnection({
        api,
        botId: bot.id,
        sessionId: session.id,
        engine: selectedEngine,
        ...(fetcher !== undefined ? { fetcher } : {}),
        getInitialCursor: (runId) => cursorMapRef.current.get(runId) ?? 0,
        onRunAdmitted: handleRunAdmitted,
        onCursorAdvance: handleCursorAdvance,
        onStreamStatus: handleStreamStatus,
        onApprovalSignal: handleApprovalSignal,
        onRunSettled: handleRunSettled,
      }),
    [
      api,
      bot.id,
      fetcher,
      handleApprovalSignal,
      handleCursorAdvance,
      handleRunAdmitted,
      handleRunSettled,
      handleStreamStatus,
      selectedEngine,
      session.id,
    ],
  );

  const chat = useChat({
    threadId: session.id,
    connection,
    onError: (error) => {
      setProblem(toOperatorProblem(error, `/api/sessions/${session.id}/runs`));
    },
  });

  setChatMessagesRef.current = chat.setMessages;

  useEffect(() => {
    void refreshHistory();
    const persisted = readPersistedCursor(session.id);
    if (persisted) {
      cursorMapRef.current.set(persisted.runId, persisted.cursor);
      setCommittedCursor(persisted.cursor);
      void refreshRunState(persisted.runId);
    }
    return () => {
      resumeAbortRef.current?.abort();
    };
  }, [refreshHistory, refreshRunState, session.id]);

  async function submitRunPrompt(text: string, engine: EngineKind, explicitKey?: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const key =
      explicitKey ??
      idempotencyTrackerRef.current.keyFor(session.id, {
        engine,
        text: trimmed,
      });

    setProblem(null);
    setFailedDraft({ text: trimmed, engine, idempotencyKey: key });
    setDraft("");

    try {
      await chat.sendMessage(trimmed, {
        body: {
          idempotencyKey: key,
          engine,
          text: trimmed,
        },
      });
    } catch (error) {
      setProblem(toOperatorProblem(error, `/api/sessions/${session.id}/runs`));
      setDraft(trimmed);
      chat.setMessages(domainMessagesToUiMessages(historyMessages));
    }
  }

  async function handleComposerSubmit(event: FormEvent) {
    event.preventDefault();
    await submitRunPrompt(draft, selectedEngine);
  }

  async function handleRetryFailedDraft() {
    if (!failedDraft) return;
    chat.setMessages(domainMessagesToUiMessages(historyMessages));
    await submitRunPrompt(failedDraft.text, failedDraft.engine, failedDraft.idempotencyKey);
  }

  async function handleReconnectRun() {
    if (!activeRun) return;
    resumeAbortRef.current?.abort();
    const controller = new AbortController();
    resumeAbortRef.current = controller;
    setResumingStream(true);
    setProblem(null);

    const startCursor = cursorMapRef.current.get(activeRun.id) ?? committedCursor;
    let streamedDelta = "";

    try {
      for await (const item of streamRunEvents({
        runId: activeRun.id,
        initialCursor: startCursor,
        signal: controller.signal,
        ...(fetcher !== undefined ? { fetcher } : {}),
        onCursorAdvance: (seq) => handleCursorAdvance(activeRun.id, seq),
        onStatusChange: (status) => setStreamStatus(status),
      })) {
        const record = item.chunk as unknown as Record<string, unknown>;
        if (record["type"] === "TEXT_MESSAGE_CONTENT" && typeof record["delta"] === "string") {
          streamedDelta += record["delta"];
        }
        if (record["type"] === "CUSTOM" && typeof record["name"] === "string") {
          if (record["name"].startsWith("approval.")) {
            void refreshRunState(activeRun.id);
          }
        }
      }
      if (streamedDelta.length > 0) {
        onAnnounce(`Replayed stream updates for run ${activeRun.id}.`);
      }
      await Promise.all([refreshRunState(activeRun.id), refreshHistory()]);
    } catch (error) {
      if (!controller.signal.aborted) {
        setProblem(toOperatorProblem(error, `/api/runs/${activeRun.id}/events`));
      }
    } finally {
      setResumingStream(false);
    }
  }

  async function handleApprovalDecision(decision: "approved" | "denied") {
    if (!activeApproval) return;
    const resolvedActor = actor.trim().length > 0 ? actor.trim() : "operator";
    setDecidingApproval(true);
    setProblem(null);
    try {
      const updated = await api.decideApproval(activeApproval.id, {
        botId: activeApproval.botId,
        sessionId: activeApproval.sessionId,
        runId: activeApproval.runId,
        status: decision,
        actor: resolvedActor,
      });
      setActiveApproval(updated);
      onAnnounce(`Recorded ${decision} decision for approval ${updated.id}.`);
      await refreshRunState(updated.runId);
      if (!chat.isLoading) {
        void handleReconnectRun();
      }
    } catch (error) {
      setProblem(toOperatorProblem(error, `/api/approvals/${activeApproval.id}/decision`));
      await refreshRunState(activeApproval.runId);
    } finally {
      setDecidingApproval(false);
    }
  }

  const displayedMessages = chat.messages;
  const activeIdempotencyKey =
    failedDraft?.idempotencyKey ?? idempotencyTrackerRef.current.peek(session.id)?.key ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{session.title}</span>
          <Badge variant="secondary" className="font-mono">
            {session.id}
          </Badge>
          {activeRun ? (
            <>
              <Separator orientation="vertical" className="h-4" />
              <span className="font-mono text-xs text-muted-foreground">run {activeRun.id}</span>
              <Badge variant={runStatusBadgeVariant(activeRun.status)}>{activeRun.status}</Badge>
            </>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono">
            SSE: {streamStatusLabel(streamStatus)}
            {committedCursor > 0 ? ` · seq #${committedCursor}` : ""}
          </Badge>
          {activeRun && !chat.isLoading ? (
            <Button
              size="sm"
              variant="outline"
              disabled={resumingStream}
              onClick={() => void handleReconnectRun()}
            >
              <RefreshCwIcon data-icon="inline-start" />
              {resumingStream ? "Reconnecting..." : "Resume stream"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={historyLoading}
            onClick={() => void refreshHistory()}
          >
            <RefreshCwIcon data-icon="inline-start" />
            Sync history
          </Button>
        </div>
      </div>

      {problem ? (
        <ProblemAlert
          problem={problem}
          onDismiss={() => setProblem(null)}
          {...(failedDraft
            ? {
                onRetry: () => void handleRetryFailedDraft(),
                retryLabel: "Retry with same key",
              }
            : {})}
        />
      ) : null}

      {activeApproval ? (
        <Card
          className={cn(
            activeApproval.decision.status === "pending"
              ? "border-status-warn/50 bg-status-warn-surface/50"
              : undefined,
          )}
          data-approval-id={activeApproval.id}
        >
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ShieldAlertIcon className="size-4 text-status-warn" aria-hidden="true" />
                <CardTitle>Exact-operation approval</CardTitle>
              </div>
              <Badge variant={approvalBadgeVariant(activeApproval.decision.status)}>
                {activeApproval.decision.status}
              </Badge>
            </div>
            <CardDescription>{activeApproval.prompt}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-muted-foreground">Operation kind</span>
                <span className="font-mono font-medium">{activeApproval.effect.operationKind}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-muted-foreground">Operation ID</span>
                <span className="font-mono font-medium">{activeApproval.effect.operationId}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-muted-foreground">Attempt ID</span>
                <span className="font-mono font-medium">{activeApproval.effect.attemptId}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-muted-foreground">Deadline (UTC)</span>
                <span className="font-mono font-medium">{activeApproval.deadline}</span>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Canonical arguments</span>
              <pre className="overflow-x-auto rounded-md border border-border bg-card p-3 font-mono text-xs leading-relaxed">
                {JSON.stringify(activeApproval.effect.canonicalArguments, null, 2)}
              </pre>
            </div>

            {activeApproval.decision.status === "approved" ||
            activeApproval.decision.status === "denied" ? (
              <p className="text-xs text-muted-foreground">
                Decided by <span className="font-mono">{activeApproval.decision.actor}</span> at{" "}
                <span className="font-mono">{activeApproval.decision.decidedAt}</span>.
              </p>
            ) : activeApproval.decision.status === "expired" ? (
              <p className="text-xs text-muted-foreground">
                Expired at <span className="font-mono">{activeApproval.decision.decidedAt}</span>.
              </p>
            ) : null}
          </CardContent>
          {activeApproval.decision.status === "pending" ? (
            <CardFooter>
              <Button
                variant="outline"
                size="sm"
                disabled={decidingApproval}
                onClick={() => void handleApprovalDecision("denied")}
              >
                <XIcon data-icon="inline-start" />
                Deny effect
              </Button>
              <Button
                size="sm"
                disabled={decidingApproval}
                onClick={() => void handleApprovalDecision("approved")}
              >
                <CheckIcon data-icon="inline-start" />
                {decidingApproval ? "Submitting..." : "Approve effect"}
              </Button>
            </CardFooter>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Scoped transcript</CardTitle>
            <span className="font-mono text-xs text-muted-foreground">
              {displayedMessages.length} {displayedMessages.length === 1 ? "message" : "messages"}
            </span>
          </div>
          <CardDescription>
            Ordered messages for session {session.id} and live native TanStack AI run chunks.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {displayedMessages.length === 0 ? (
            <Empty className="border-0 bg-transparent py-8">
              <EmptyHeader>
                <EmptyMedia>
                  <MessageSquareIcon />
                </EmptyMedia>
                <EmptyTitle>No messages in this session</EmptyTitle>
                <EmptyDescription>
                  Send a prompt below to admit a durable run on {selectedEngine}.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ol
              className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto pr-1"
              aria-label="Chat messages"
            >
              {displayedMessages.map((msg) => {
                const isUser = msg.role === "user";
                return (
                  <li
                    key={msg.id}
                    className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}
                  >
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="font-medium">{isUser ? "Operator" : bot.name}</span>
                      {msg.createdAt ? (
                        <span className="font-mono">{msg.createdAt.toISOString()}</span>
                      ) : null}
                    </div>
                    <div
                      className={cn(
                        "flex max-w-[72ch] flex-col gap-2 rounded-lg border px-4 py-2.5",
                        isUser
                          ? "border-primary/25 bg-primary text-primary-foreground"
                          : "border-border bg-muted/40 text-foreground",
                      )}
                    >
                      {msg.parts.length > 0 ? (
                        msg.parts.map((part, index) => renderMessagePart(part, index))
                      ) : (
                        <span className="text-xs italic opacity-75">
                          Waiting for stream chunks...
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>

      <Card>
        <form onSubmit={handleComposerSubmit}>
          <CardContent className="flex flex-col gap-3 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Field orientation="horizontal" className="w-fit">
                <FieldLabel htmlFor="composer-engine-select">Engine</FieldLabel>
                <div className="w-40">
                  <Select
                    value={selectedEngine}
                    onValueChange={(value) => setSelectedEngine(value as EngineKind)}
                  >
                    <SelectTrigger id="composer-engine-select">
                      <SelectValue placeholder="Engine" />
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
                </div>
              </Field>

              {activeIdempotencyKey ? (
                <span className="font-mono text-[11px] text-muted-foreground">
                  Idempotency-Key: {activeIdempotencyKey}
                </span>
              ) : null}
            </div>

            <Field>
              <FieldLabel htmlFor="run-prompt-input" className="sr-only">
                Prompt
              </FieldLabel>
              <Textarea
                id="run-prompt-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
                placeholder={`Send an instruction to ${bot.name}...`}
                disabled={chat.isLoading}
              />
            </Field>
          </CardContent>

          <CardFooter className="justify-between">
            <span className="text-xs text-muted-foreground">
              {chat.isLoading
                ? "Streaming native chunks over SSE..."
                : "Retries preserve the active Idempotency-Key until admitted."}
            </span>
            <div className="flex items-center gap-2">
              {chat.isLoading ? (
                <Button variant="outline" size="sm" onClick={() => chat.stop()}>
                  <SquareIcon data-icon="inline-start" />
                  Stop stream
                </Button>
              ) : null}
              <Button
                type="submit"
                size="sm"
                disabled={chat.isLoading || draft.trim().length === 0}
              >
                <SendIcon data-icon="inline-start" />
                Send prompt
              </Button>
            </div>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
