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
import {
  colorVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  textSizeVars,
  typographyVars,
} from "@astryxdesign/core/theme/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { CheckIcon, MessageSquareIcon, RefreshCwIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  capabilitySearchHit,
  executeResult,
  type Approval,
  type Bot,
  type EngineKind,
  type Message,
  type ProblemDetails,
  type Run,
  type RunAdmission,
  type RunUsage,
  type Session,
} from "@der/domain";
import { useChat, type UIMessage } from "@tanstack/ai-react";
import * as z from "zod";
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

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-4"],
  },
  toolbar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacingVars["--spacing-3"],
    borderRadius: radiusVars["--radius-container"],
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colorVars["--color-border"],
    backgroundColor: colorVars["--color-background-card"],
    paddingInline: spacingVars["--spacing-4"],
    paddingBlock: spacingVars["--spacing-3"],
  },
  inlineGroup: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacingVars["--spacing-2"],
  },
  sessionTitle: {
    fontSize: textSizeVars["--font-size-base"],
    fontWeight: fontWeightVars["--font-weight-semibold"],
  },
  verticalDivider: {
    height: spacingVars["--spacing-4"],
  },
  monoMuted: {
    fontFamily: typographyVars["--font-family-code"],
    fontSize: textSizeVars["--font-size-sm"],
    color: colorVars["--color-text-secondary"],
  },
  usageList: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-0-5"],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  approvalBody: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-3"],
  },
  columnGap1: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-1"],
  },
  columnGap2: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-2"],
  },
  columnGap05: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-0-5"],
  },
  rowBetweenWrap: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacingVars["--spacing-2"],
  },
  rowCenterGap2: {
    display: "flex",
    alignItems: "center",
    gap: spacingVars["--spacing-2"],
  },
  warningIcon: {
    width: "1rem",
    height: "1rem",
    color: colorVars["--color-icon-warning"],
  },
  approvalGrid: {
    display: "grid",
    gap: spacingVars["--spacing-2"],
    fontSize: textSizeVars["--font-size-sm"],
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))",
      "@media (min-width: 1024px)": "repeat(4, minmax(0, 1fr))",
    },
  },
  mutedLabel: {
    fontSize: textSizeVars["--font-size-sm"],
    color: colorVars["--color-text-secondary"],
  },
  monoMedium: {
    fontFamily: typographyVars["--font-family-code"],
    fontWeight: fontWeightVars["--font-weight-medium"],
  },
  monoInline: {
    fontFamily: typographyVars["--font-family-code"],
  },
  canonicalArgs: {
    overflowX: "auto",
    borderRadius: radiusVars["--radius-element"],
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colorVars["--color-border"],
    backgroundColor: colorVars["--color-background-card"],
    paddingInline: spacingVars["--spacing-3"],
    paddingBlock: spacingVars["--spacing-3"],
    fontFamily: typographyVars["--font-family-code"],
    fontSize: textSizeVars["--font-size-sm"],
    lineHeight: 1.625,
  },
  approvalActions: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: spacingVars["--spacing-2"],
    paddingTop: spacingVars["--spacing-1"],
  },
  transcriptHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacingVars["--spacing-2"],
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colorVars["--color-border"],
    paddingInline: spacingVars["--spacing-4"],
    paddingBlock: spacingVars["--spacing-3"],
  },
  chatLayout: {
    minHeight: "26rem",
    maxHeight: "38rem",
  },
  promptTextarea: {
    width: "100%",
    resize: "vertical",
    backgroundColor: "transparent",
    fontSize: textSizeVars["--font-size-base"],
    color: colorVars["--color-text-primary"],
    outlineStyle: "none",
    "::placeholder": {
      color: colorVars["--color-text-secondary"],
    },
  },
  toolDetailBox: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-2"],
    fontFamily: typographyVars["--font-family-code"],
    fontSize: textSizeVars["--font-size-sm"],
  },
  toolArgsPre: {
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    color: colorVars["--color-text-secondary"],
  },
  toolResultPre: {
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    borderTopWidth: 1,
    borderTopStyle: "solid",
    borderTopColor: colorVars["--color-border"],
    paddingTop: spacingVars["--spacing-2"],
  },
  toolResultSoloPre: {
    overflowX: "auto",
    fontFamily: typographyVars["--font-family-code"],
    fontSize: textSizeVars["--font-size-sm"],
    whiteSpace: "pre-wrap",
  },
  messageText: {
    fontSize: textSizeVars["--font-size-base"],
    lineHeight: 1.625,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  },
  thinkingBox: {
    borderRadius: radiusVars["--radius-element"],
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colorVars["--color-border"],
    backgroundColor: colorVars["--color-background-muted"],
    paddingInline: spacingVars["--spacing-3"],
    paddingBlock: spacingVars["--spacing-2"],
    fontSize: textSizeVars["--font-size-sm"],
    color: colorVars["--color-text-secondary"],
    fontStyle: "italic",
    whiteSpace: "pre-wrap",
  },
  waitingHint: {
    fontSize: textSizeVars["--font-size-sm"],
    fontStyle: "italic",
    opacity: 0.75,
  },
  iconSm: {
    width: "0.875rem",
    height: "0.875rem",
  },
  iconLg: {
    width: "1.5rem",
    height: "1.5rem",
  },
});

interface PersistedRunCursor {
  readonly runId: string;
  readonly cursor: number;
}

interface FailedDraftRetry {
  readonly text: string;
  readonly engine: EngineKind;
  readonly idempotencyKey: string;
}

function dashIfNull(value: number | null): string {
  return value === null ? "-" : String(value);
}

function tokenSummary(usage: RunUsage): string {
  return [
    `input ${usage.inputTokens}`,
    `cached ${dashIfNull(usage.cachedInputTokens)}`,
    `cache write ${dashIfNull(usage.cacheWriteTokens)}`,
    `output ${usage.outputTokens}`,
  ].join(" · ");
}

function runUsageLine(run: Run & { readonly usage: RunUsage }): string {
  const parts = [`${run.id} · ${tokenSummary(run.usage)}`];
  if (run.contextMode !== null) parts.push(run.contextMode);
  if (run.usage.reportedCostUsd !== null) {
    parts.push(`vendor running cost $${run.usage.reportedCostUsd}`);
  }
  return parts.join(" · ");
}

function sumNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0);
}

function sessionUsageTotalsLine(usages: readonly RunUsage[]): string {
  return `Session total · ${tokenSummary({
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    cachedInputTokens: sumNullable(usages.map((usage) => usage.cachedInputTokens)),
    cacheWriteTokens: sumNullable(usages.map((usage) => usage.cacheWriteTokens)),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    reportedCostUsd: null,
  })}`;
}

export interface ChatWorkspaceProps {
  readonly api: OperatorApi;
  readonly fetcher?: typeof fetch;
  readonly bot: Bot;
  readonly session: Session;
  readonly actor: string;
  readonly onAnnounce: (message: string) => void;
}

const USAGE_RETRY_DELAY_MS = 1_000;
const USAGE_RETRY_LIMIT = 3;

function isTerminalRunStatus(status: Run["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled"
  );
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

const executeArgs = z.object({ script: z.string() });
const searchArgs = z.object({ query: z.string() });
const searchResult = z.object({ hits: z.array(capabilitySearchHit), truncated: z.boolean() });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface ToolCallView {
  readonly args: ReactNode;
  readonly result: ReactNode;
  readonly errorMessage: string | undefined;
}

function executeView(argsText: string, resultText: string | null): ToolCallView {
  const script = executeArgs.safeParse(parseJson(argsText));
  const outcome = executeResult.safeParse(resultText === null ? undefined : parseJson(resultText));
  const args = (
    <pre {...stylex.props(styles.toolArgsPre)}>
      {script.success ? script.data.script : argsText}
    </pre>
  );
  if (!outcome.success) {
    return {
      args,
      result:
        resultText === null ? null : (
          <pre {...stylex.props(styles.toolResultPre)}>{resultText}</pre>
        ),
      errorMessage: undefined,
    };
  }
  const value = outcome.data;
  const logs =
    value.logs.length > 0 ? (
      <pre {...stylex.props(styles.toolArgsPre)}>{value.logs.join("\n")}</pre>
    ) : null;
  if (!value.ok) {
    return {
      args,
      result: (
        <>
          <pre
            {...stylex.props(styles.toolResultPre)}
          >{`${value.error.kind}: ${value.error.message}`}</pre>
          {logs}
        </>
      ),
      errorMessage: `${value.error.kind}: ${value.error.message}`,
    };
  }
  return {
    args,
    result: (
      <>
        <pre {...stylex.props(styles.toolResultPre)}>
          {JSON.stringify(value.result, null, 2)}
          {value.truncated ? "\nResult truncated" : ""}
        </pre>
        {logs}
      </>
    ),
    errorMessage: undefined,
  };
}

function searchView(argsText: string, resultText: string | null): ToolCallView {
  const query = searchArgs.safeParse(parseJson(argsText));
  const outcome = searchResult.safeParse(resultText === null ? undefined : parseJson(resultText));
  const args = (
    <pre {...stylex.props(styles.toolArgsPre)}>{query.success ? query.data.query : argsText}</pre>
  );
  if (!outcome.success) {
    return {
      args,
      result:
        resultText === null ? null : (
          <pre {...stylex.props(styles.toolResultPre)}>{resultText}</pre>
        ),
      errorMessage: undefined,
    };
  }
  const ids = outcome.data.hits.map((hit) => hit.id);
  return {
    args,
    result: (
      <pre {...stylex.props(styles.toolResultPre)}>
        {ids.length > 0 ? ids.join("\n") : "No matching capabilities"}
        {outcome.data.truncated ? "\nResults truncated" : ""}
      </pre>
    ),
    errorMessage: undefined,
  };
}

function genericView(argsText: string, resultText: string | null): ToolCallView {
  return {
    args: <pre {...stylex.props(styles.toolArgsPre)}>{argsText}</pre>,
    result:
      resultText === null ? null : <pre {...stylex.props(styles.toolResultPre)}>{resultText}</pre>,
    errorMessage: undefined,
  };
}

function toolCallView(name: string, argsText: string, resultText: string | null): ToolCallView {
  if (name === "execute") return executeView(argsText, resultText);
  if (name === "search") return searchView(argsText, resultText);
  return genericView(argsText, resultText);
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
      const resultText = result
        ? typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content, null, 2)
        : null;
      const view = toolCallView(part.name, part.arguments, resultText);
      const errorMessage =
        view.errorMessage ??
        (result?.state === "error" ? "Tool returned an error outcome." : undefined);
      const status = errorMessage !== undefined ? "error" : result ? "complete" : "running";

      items.push({
        key: part.id,
        name: part.name,
        status,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
        resultDetail: (
          <div {...stylex.props(styles.toolDetailBox)}>
            {view.args}
            {view.result}
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
        resultDetail: <pre {...stylex.props(styles.toolResultSoloPre)}>{resultText}</pre>,
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
  const [sessionRuns, setSessionRuns] = useState<Run[]>([]);
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
  const usageRetryRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const usageWatchRunRef = useRef<string | undefined>(undefined);

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

  const refreshSessionRuns = useCallback(async (): Promise<readonly Run[] | undefined> => {
    try {
      const runs = await api.listSessionRuns(session.id);
      setSessionRuns(runs);
      return runs;
    } catch (error) {
      setProblem(toOperatorProblem(error, `/api/sessions/${session.id}/runs`));
      return undefined;
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
      // The stream can close before the finish step commits status and usage; look again a
      // bounded number of times.
      usageWatchRunRef.current = runId;
      clearTimeout(usageRetryRef.current);
      const watchUsage = (retriesLeft: number) => {
        void refreshSessionRuns().then((runs) => {
          const watched = runs?.find((sessionRun) => sessionRun.id === runId);
          if (
            usageWatchRunRef.current !== runId ||
            watched === undefined ||
            retriesLeft === 0 ||
            (isTerminalRunStatus(watched.status) && watched.usage !== null)
          ) {
            return;
          }
          usageRetryRef.current = setTimeout(
            () => watchUsage(retriesLeft - 1),
            USAGE_RETRY_DELAY_MS,
          );
        });
      };
      watchUsage(USAGE_RETRY_LIMIT);
    },
    [refreshHistory, refreshRunState, refreshSessionRuns],
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
    void refreshSessionRuns();
    const persisted = readPersistedCursor(session.id);
    if (persisted) {
      cursorMapRef.current.set(persisted.runId, persisted.cursor);
      setCommittedCursor(persisted.cursor);
      void refreshRunState(persisted.runId);
    }
    return () => {
      resumeAbortRef.current?.abort();
      usageWatchRunRef.current = undefined;
      clearTimeout(usageRetryRef.current);
    };
  }, [refreshHistory, refreshRunState, refreshSessionRuns, session.id]);

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
  const usageRuns = sessionRuns.flatMap((sessionRun) =>
    sessionRun.usage === null ? [] : [{ ...sessionRun, usage: sessionRun.usage }],
  );
  const engineOptions = bot.allowedEngines.map((kind) => ({ value: kind, label: kind }));

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.toolbar)}>
        <div {...stylex.props(styles.inlineGroup)}>
          <span {...stylex.props(styles.sessionTitle)}>{session.title}</span>
          <Badge variant="neutral" label={session.id} />
          {activeRun ? (
            <>
              <Divider orientation="vertical" xstyle={styles.verticalDivider} />
              <span {...stylex.props(styles.monoMuted)}>run {activeRun.id}</span>
              <Badge variant={runStatusBadgeVariant(activeRun.status)} label={activeRun.status} />
            </>
          ) : null}
        </div>

        <div {...stylex.props(styles.inlineGroup)}>
          <Badge
            variant="neutral"
            label={`SSE: ${streamStatusLabel(streamStatus)}${committedCursor > 0 ? ` · seq #${committedCursor}` : ""}`}
          />
          {activeRun && !chat.isLoading ? (
            <Button
              size="sm"
              variant="secondary"
              label={resumingStream ? "Reconnecting..." : "Resume stream"}
              icon={<RefreshCwIcon {...stylex.props(styles.iconSm)} aria-hidden="true" />}
              isDisabled={resumingStream}
              onClick={() => void handleReconnectRun()}
            />
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            label="Sync history"
            icon={<RefreshCwIcon {...stylex.props(styles.iconSm)} aria-hidden="true" />}
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
          <div {...stylex.props(styles.approvalBody)}>
            <div {...stylex.props(styles.columnGap1)}>
              <div {...stylex.props(styles.rowBetweenWrap)}>
                <div {...stylex.props(styles.rowCenterGap2)}>
                  <ShieldAlertIcon {...stylex.props(styles.warningIcon)} aria-hidden="true" />
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

            <div {...stylex.props(styles.approvalGrid)}>
              <div {...stylex.props(styles.columnGap05)}>
                <span {...stylex.props(styles.mutedLabel)}>Operation kind</span>
                <span {...stylex.props(styles.monoMedium)}>
                  {activeApproval.effect.operationKind}
                </span>
              </div>
              <div {...stylex.props(styles.columnGap05)}>
                <span {...stylex.props(styles.mutedLabel)}>Operation ID</span>
                <span {...stylex.props(styles.monoMedium)}>
                  {activeApproval.effect.operationId}
                </span>
              </div>
              <div {...stylex.props(styles.columnGap05)}>
                <span {...stylex.props(styles.mutedLabel)}>Attempt ID</span>
                <span {...stylex.props(styles.monoMedium)}>{activeApproval.effect.attemptId}</span>
              </div>
              <div {...stylex.props(styles.columnGap05)}>
                <span {...stylex.props(styles.mutedLabel)}>Deadline (UTC)</span>
                <span {...stylex.props(styles.monoMedium)}>{activeApproval.deadline}</span>
              </div>
            </div>

            <div {...stylex.props(styles.columnGap1)}>
              <span {...stylex.props(styles.mutedLabel)}>Canonical arguments</span>
              <pre {...stylex.props(styles.canonicalArgs)}>
                {JSON.stringify(activeApproval.effect.canonicalArguments, null, 2)}
              </pre>
            </div>

            {activeApproval.decision.status === "approved" ||
            activeApproval.decision.status === "denied" ? (
              <p {...stylex.props(styles.mutedLabel)}>
                Decided by{" "}
                <span {...stylex.props(styles.monoInline)}>{activeApproval.decision.actor}</span> at{" "}
                <span {...stylex.props(styles.monoInline)}>
                  {activeApproval.decision.decidedAt}
                </span>
                .
              </p>
            ) : activeApproval.decision.status === "expired" ? (
              <p {...stylex.props(styles.mutedLabel)}>
                Expired at{" "}
                <span {...stylex.props(styles.monoInline)}>
                  {activeApproval.decision.decidedAt}
                </span>
                .
              </p>
            ) : null}

            {activeApproval.decision.status === "pending" ? (
              <div {...stylex.props(styles.approvalActions)}>
                <Button
                  variant="secondary"
                  size="sm"
                  label="Deny effect"
                  icon={<XIcon {...stylex.props(styles.iconSm)} aria-hidden="true" />}
                  isDisabled={decidingApproval}
                  onClick={() => void handleApprovalDecision("denied")}
                />
                <Button
                  variant="primary"
                  size="sm"
                  label={decidingApproval ? "Submitting..." : "Approve effect"}
                  icon={<CheckIcon {...stylex.props(styles.iconSm)} aria-hidden="true" />}
                  isDisabled={decidingApproval}
                  onClick={() => void handleApprovalDecision("approved")}
                />
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {usageRuns.length > 0 ? (
        <div {...stylex.props(styles.columnGap05)}>
          <p {...stylex.props(styles.monoMuted)}>
            {sessionUsageTotalsLine(usageRuns.map((usageRun) => usageRun.usage))}
          </p>
          <ul {...stylex.props(styles.usageList)} aria-label="Run usage">
            {usageRuns.map((usageRun) => (
              <li key={usageRun.id} {...stylex.props(styles.monoMuted)}>
                {runUsageLine(usageRun)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Card padding={0}>
        <div {...stylex.props(styles.transcriptHeader)}>
          <div {...stylex.props(styles.columnGap05)}>
            <Heading level={3}>Scoped transcript</Heading>
            <Text type="supporting">
              Ordered messages for session {session.id} and live native TanStack AI run chunks.
            </Text>
          </div>
          <span {...stylex.props(styles.monoMuted)}>
            {displayedMessages.length} {displayedMessages.length === 1 ? "message" : "messages"}
          </span>
        </div>

        <ChatLayout
          density="compact"
          xstyle={styles.chatLayout}
          emptyState={
            <EmptyState
              icon={<MessageSquareIcon {...stylex.props(styles.iconLg)} aria-hidden="true" />}
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
                <span {...stylex.props(styles.mutedLabel)}>
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
                  {...stylex.props(styles.promptTextarea)}
                />
              }
              footerActions={
                <div {...stylex.props(styles.inlineGroup)}>
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
                    <span {...stylex.props(styles.monoMuted)}>
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
                        <div {...stylex.props(styles.columnGap2)}>
                          {textParts.map((part, index) => {
                            if (part.type === "text") {
                              return (
                                <p key={`text-${index}`} {...stylex.props(styles.messageText)}>
                                  {part.content}
                                </p>
                              );
                            }
                            if (part.type === "thinking") {
                              return (
                                <div key={`think-${index}`} {...stylex.props(styles.thinkingBox)}>
                                  {part.content}
                                </div>
                              );
                            }
                            return null;
                          })}
                        </div>
                      ) : toolCalls.length === 0 ? (
                        <span {...stylex.props(styles.waitingHint)}>
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
