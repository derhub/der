import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import {
  ChatComposer,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageMetadata,
  ChatMessageList,
  ChatSendButton,
  ChatToolCalls,
  type ChatToolCallItem,
} from "@astryxdesign/core/Chat";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { CheckIcon, MessageSquareIcon, RefreshCwIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
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
import { createIdempotencyTracker } from "@/lib/idempotency";
import type { OperatorApi } from "@/lib/operator-api";
import {
  createDerChatConnection,
  domainMessagesToUiMessages,
  streamRunEvents,
  type RunStreamStatus,
} from "@/lib/run-stream";
import { toOperatorProblem } from "@/lib/schemas";

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

function runStatusBadgeVariant(status: Run["status"]): BadgeVariant {
  if (status === "completed") return "success";
  if (status === "waiting_approval") return "warning";
  if (status === "failed" || status === "interrupted" || status === "cancelled") return "error";
  if (status === "running") return "info";
  return "neutral";
}

function approvalBadgeVariant(status: Approval["decision"]["status"]): BadgeVariant {
  if (status === "approved") return "success";
  if (status === "pending") return "warning";
  return "error";
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

function extractToolCallItems(parts: UIMessage["parts"]): ChatToolCallItem[] {
  const resultsById = new Map<
    string,
    Extract<UIMessage["parts"][number], { type: "tool-result" }>
  >();
  for (const part of parts) {
    if (part.type === "tool-result") {
      resultsById.set(part.toolCallId, part);
    }
  }

  const items: ChatToolCallItem[] = [];
  const consumedResultIds = new Set<string>();

  for (const part of parts) {
    if (part.type === "tool-call") {
      const result = resultsById.get(part.id);
      if (result) {
        consumedResultIds.add(part.id);
      }
      const isError = result?.state === "error";
      const status = isError ? "error" : result ? "complete" : "running";
      const resultText = result
        ? typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content, null, 2)
        : null;

      items.push({
        key: part.id,
        name: part.name,
        status,
        ...(isError ? { errorMessage: "Tool returned an error outcome." } : {}),
        resultDetail: (
          <div className="flex flex-col gap-2 font-mono text-xs">
            <pre className="overflow-x-auto whitespace-pre-wrap text-secondary">
              {part.arguments}
            </pre>
            {resultText !== null ? (
              <pre className="overflow-x-auto whitespace-pre-wrap border-t border-border pt-2">
                {resultText}
              </pre>
            ) : null}
          </div>
        ),
      });
    }
  }

  for (const part of parts) {
    if (part.type === "tool-result" && !consumedResultIds.has(part.toolCallId)) {
      const isError = part.state === "error";
      const resultText =
        typeof part.content === "string" ? part.content : JSON.stringify(part.content, null, 2);
      items.push({
        key: part.toolCallId,
        name: part.toolCallId,
        status: isError ? "error" : "complete",
        ...(isError ? { errorMessage: "Tool returned an error outcome." } : {}),
        resultDetail: (
          <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">{resultText}</pre>
        ),
      });
    }
  }

  return items;
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

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!chat.isLoading && draft.trim().length > 0) {
        void submitRunPrompt(draft, selectedEngine);
      }
    }
  }

  const displayedMessages = chat.messages;
  const activeIdempotencyKey =
    failedDraft?.idempotencyKey ?? idempotencyTrackerRef.current.peek(session.id)?.key ?? null;
  const engineOptions = bot.allowedEngines.map((kind) => ({ value: kind, label: kind }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{session.title}</span>
          <Badge variant="neutral" label={session.id} />
          {activeRun ? (
            <>
              <Divider orientation="vertical" className="h-4" />
              <span className="font-mono text-xs text-secondary">run {activeRun.id}</span>
              <Badge variant={runStatusBadgeVariant(activeRun.status)} label={activeRun.status} />
            </>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="neutral"
            label={`SSE: ${streamStatusLabel(streamStatus)}${committedCursor > 0 ? ` · seq #${committedCursor}` : ""}`}
          />
          {activeRun && !chat.isLoading ? (
            <Button
              size="sm"
              variant="secondary"
              label={resumingStream ? "Reconnecting..." : "Resume stream"}
              icon={<RefreshCwIcon className="size-3.5" aria-hidden="true" />}
              isDisabled={resumingStream}
              onClick={() => void handleReconnectRun()}
            />
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            label="Sync history"
            icon={<RefreshCwIcon className="size-3.5" aria-hidden="true" />}
            isDisabled={historyLoading}
            onClick={() => void refreshHistory()}
          />
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
          variant={activeApproval.decision.status === "pending" ? "yellow" : "default"}
          data-approval-id={activeApproval.id}
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <ShieldAlertIcon className="size-4 text-warning" aria-hidden="true" />
                  <Heading level={3}>Exact-operation approval</Heading>
                </div>
                <Badge
                  variant={approvalBadgeVariant(activeApproval.decision.status)}
                  label={activeApproval.decision.status}
                />
              </div>
              <Text type="supporting" as="p">
                {activeApproval.prompt}
              </Text>
            </div>

            <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-secondary">Operation kind</span>
                <span className="font-mono font-medium">{activeApproval.effect.operationKind}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-secondary">Operation ID</span>
                <span className="font-mono font-medium">{activeApproval.effect.operationId}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-secondary">Attempt ID</span>
                <span className="font-mono font-medium">{activeApproval.effect.attemptId}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-secondary">Deadline (UTC)</span>
                <span className="font-mono font-medium">{activeApproval.deadline}</span>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-secondary">Canonical arguments</span>
              <pre className="overflow-x-auto rounded-md border border-border bg-card p-3 font-mono text-xs leading-relaxed">
                {JSON.stringify(activeApproval.effect.canonicalArguments, null, 2)}
              </pre>
            </div>

            {activeApproval.decision.status === "approved" ||
            activeApproval.decision.status === "denied" ? (
              <p className="text-xs text-secondary">
                Decided by <span className="font-mono">{activeApproval.decision.actor}</span> at{" "}
                <span className="font-mono">{activeApproval.decision.decidedAt}</span>.
              </p>
            ) : activeApproval.decision.status === "expired" ? (
              <p className="text-xs text-secondary">
                Expired at <span className="font-mono">{activeApproval.decision.decidedAt}</span>.
              </p>
            ) : null}

            {activeApproval.decision.status === "pending" ? (
              <div className="flex flex-wrap justify-end gap-2 pt-1">
                <Button
                  variant="secondary"
                  size="sm"
                  label="Deny effect"
                  icon={<XIcon className="size-3.5" aria-hidden="true" />}
                  isDisabled={decidingApproval}
                  onClick={() => void handleApprovalDecision("denied")}
                />
                <Button
                  variant="primary"
                  size="sm"
                  label={decidingApproval ? "Submitting..." : "Approve effect"}
                  icon={<CheckIcon className="size-3.5" aria-hidden="true" />}
                  isDisabled={decidingApproval}
                  onClick={() => void handleApprovalDecision("approved")}
                />
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card padding={0}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <Heading level={3}>Scoped transcript</Heading>
            <Text type="supporting">
              Ordered messages for session {session.id} and live native TanStack AI run chunks.
            </Text>
          </div>
          <span className="font-mono text-xs text-secondary">
            {displayedMessages.length} {displayedMessages.length === 1 ? "message" : "messages"}
          </span>
        </div>

        <ChatLayout
          density="compact"
          className="min-h-[26rem] max-h-[38rem]"
          emptyState={
            <EmptyState
              icon={<MessageSquareIcon className="size-6" aria-hidden="true" />}
              title="No messages in this session"
              description={`Send a prompt below to admit a durable run on ${selectedEngine}.`}
            />
          }
          composer={
            <ChatComposer
              density="compact"
              elevation="none"
              value={draft}
              onChange={setDraft}
              onSubmit={(value) => void submitRunPrompt(value, selectedEngine)}
              onStop={() => chat.stop()}
              isStopShown={chat.isLoading}
              isDisabled={chat.isLoading}
              placeholder={`Send an instruction to ${bot.name}...`}
              headerContext={
                <span className="text-xs text-secondary">
                  {chat.isLoading
                    ? "Streaming native chunks over SSE..."
                    : "Retries preserve the active Idempotency-Key until admitted."}
                </span>
              }
              input={
                <textarea
                  id="run-prompt-input"
                  aria-label="Prompt"
                  rows={3}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleTextareaKeyDown}
                  placeholder={`Send an instruction to ${bot.name}...`}
                  disabled={chat.isLoading}
                  className="w-full resize-y bg-transparent text-sm text-primary outline-none placeholder:text-secondary"
                />
              }
              footerActions={
                <div className="flex flex-wrap items-center gap-2">
                  <Selector
                    id="composer-engine-select"
                    label="Engine"
                    isLabelHidden
                    size="sm"
                    variant="secondary"
                    width={152}
                    value={selectedEngine}
                    options={engineOptions}
                    onChange={(value) => setSelectedEngine(value as EngineKind)}
                    placeholder="Engine"
                  />
                  {activeIdempotencyKey ? (
                    <span className="font-mono text-xs text-secondary">
                      Idempotency-Key: {activeIdempotencyKey}
                    </span>
                  ) : null}
                </div>
              }
              sendButton={<ChatSendButton />}
            />
          }
        >
          {displayedMessages.length > 0 ? (
            <ChatMessageList align="top" isStreaming={chat.isLoading} aria-label="Chat messages">
              {displayedMessages.map((msg) => {
                const sender =
                  msg.role === "user" ? "user" : msg.role === "system" ? "system" : "assistant";
                const senderLabel = sender === "user" ? "Operator" : bot.name;
                const toolCalls = extractToolCallItems(msg.parts);
                const textParts = msg.parts.filter(
                  (part) => part.type === "text" || part.type === "thinking",
                );

                return (
                  <ChatMessage key={msg.id} sender={sender}>
                    {toolCalls.length > 0 ? <ChatToolCalls calls={toolCalls} /> : null}
                    <ChatMessageBubble
                      name={senderLabel}
                      metadata={
                        msg.createdAt ? (
                          <ChatMessageMetadata timestamp={msg.createdAt.toISOString()} />
                        ) : undefined
                      }
                    >
                      {textParts.length > 0 ? (
                        <div className="flex flex-col gap-2">
                          {textParts.map((part, index) => {
                            if (part.type === "text") {
                              return (
                                <p
                                  key={`text-${index}`}
                                  className="text-sm leading-relaxed whitespace-pre-wrap break-words"
                                >
                                  {part.content}
                                </p>
                              );
                            }
                            if (part.type === "thinking") {
                              return (
                                <div
                                  key={`think-${index}`}
                                  className="rounded-md border border-dashed border-border bg-muted px-3 py-2 text-xs text-secondary italic whitespace-pre-wrap"
                                >
                                  {part.content}
                                </div>
                              );
                            }
                            return null;
                          })}
                        </div>
                      ) : toolCalls.length === 0 ? (
                        <span className="text-xs italic opacity-75">
                          Waiting for stream chunks...
                        </span>
                      ) : null}
                    </ChatMessageBubble>
                  </ChatMessage>
                );
              })}
            </ChatMessageList>
          ) : null}
        </ChatLayout>
      </Card>
    </div>
  );
}
