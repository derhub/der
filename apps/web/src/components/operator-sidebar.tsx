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
import {
  colorVars,
  durationVars,
  easeVars,
  focusVars,
  fontWeightVars,
  radiusVars,
  shadowVars,
  spacingVars,
  textSizeVars,
  typographyVars,
} from "@astryxdesign/core/theme/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BotIcon, MessageSquareIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import type {
  Bot,
  CapabilityPolicy,
  CreateBotInput,
  EngineKind,
  PolicyDecision,
  ProblemDetails,
  Session,
  UpdateBotInput,
} from "@der/domain";
import { ProblemAlert } from "@/components/problem-alert";
import { consoleQueryKeys } from "@/lib/console-queries";
import type { CreateSessionPayload, OperatorApi } from "@/lib/operator-api";
import { toOperatorProblem } from "@/lib/schemas";

interface PolicyRow {
  readonly id: number;
  readonly selector: string;
  readonly decision: PolicyDecision;
}

const POLICY_DECISION_OPTIONS = [
  { value: "allow", label: "allow" },
  { value: "ask", label: "ask" },
  { value: "deny", label: "deny" },
];

function policyFromRows(rows: readonly PolicyRow[]): CapabilityPolicy {
  const entries = rows
    .map(({ selector, decision }) => [selector.trim(), decision] as const)
    .filter(([selector]) => selector.length > 0);
  return Object.fromEntries(entries);
}

const styles = stylex.create({
  sidebar: {
    display: "flex",
    height: "100%",
    width: {
      default: "100%",
      "@media (min-width: 768px)": "18rem",
    },
    flexShrink: {
      default: null,
      "@media (min-width: 768px)": 0,
    },
    flexDirection: "column",
    borderRightWidth: 1,
    borderRightStyle: "solid",
    borderRightColor: colorVars["--color-border"],
    backgroundColor: colorVars["--color-background-surface"],
    color: colorVars["--color-text-primary"],
  },
  brandHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacingVars["--spacing-2"],
    paddingInline: spacingVars["--spacing-4"],
    paddingBlock: "0.875rem",
  },
  brandIdentity: {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
  },
  brandMark: {
    width: spacingVars["--spacing-7"],
    height: spacingVars["--spacing-7"],
    borderRadius: radiusVars["--radius-element"],
  },
  brandText: {
    display: "flex",
    flexDirection: "column",
  },
  brandTitle: {
    fontSize: textSizeVars["--font-size-base"],
    fontWeight: fontWeightVars["--font-weight-semibold"],
    letterSpacing: "-0.025em",
    lineHeight: 1,
  },
  scrollArea: {
    display: "flex",
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    flexDirection: "column",
    gap: spacingVars["--spacing-5"],
    overflowY: "auto",
    paddingInline: spacingVars["--spacing-3"],
    paddingBlock: spacingVars["--spacing-4"],
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-2"],
  },
  sectionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    paddingInline: spacingVars["--spacing-1"],
  },
  emptyHint: {
    paddingInline: spacingVars["--spacing-2"],
    paddingBlock: spacingVars["--spacing-2"],
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-1"],
  },
  botListItem: {
    display: "flex",
    alignItems: "center",
    gap: spacingVars["--spacing-1"],
  },
  botButton: {
    display: "flex",
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "0%",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacingVars["--spacing-2"],
    borderRadius: radiusVars["--radius-element"],
    paddingInline: "0.625rem",
    paddingBlock: spacingVars["--spacing-2"],
    textAlign: "left",
    fontSize: textSizeVars["--font-size-base"],
    color: {
      default: colorVars["--color-text-secondary"],
      ":hover": colorVars["--color-text-primary"],
    },
    backgroundColor: {
      default: "transparent",
      ":hover": colorVars["--color-overlay-hover"],
    },
    transitionProperty: "color, background-color, box-shadow",
    transitionDuration: durationVars["--duration-fast"],
    transitionTimingFunction: easeVars["--ease-standard"],
    outlineStyle: {
      default: null,
      ":focus-visible": "solid",
    },
    outlineWidth: {
      default: null,
      ":focus-visible": focusVars["--focus-outline-width"],
    },
    outlineColor: {
      default: null,
      ":focus-visible": colorVars["--color-info"],
    },
  },
  botButtonSelected: {
    backgroundColor: {
      default: colorVars["--color-background-card"],
      ":hover": colorVars["--color-background-card"],
    },
    fontWeight: fontWeightVars["--font-weight-medium"],
    color: colorVars["--color-text-primary"],
    boxShadow: shadowVars["--shadow-low"],
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colorVars["--color-border"],
  },
  sessionButton: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacingVars["--spacing-2"],
    borderRadius: radiusVars["--radius-element"],
    paddingInline: "0.625rem",
    paddingBlock: spacingVars["--spacing-2"],
    textAlign: "left",
    fontSize: textSizeVars["--font-size-base"],
    color: {
      default: colorVars["--color-text-secondary"],
      ":hover": colorVars["--color-text-primary"],
    },
    backgroundColor: {
      default: "transparent",
      ":hover": colorVars["--color-overlay-hover"],
    },
    transitionProperty: "color, background-color",
    transitionDuration: durationVars["--duration-fast"],
    transitionTimingFunction: easeVars["--ease-standard"],
    outlineStyle: {
      default: null,
      ":focus-visible": "solid",
    },
    outlineWidth: {
      default: null,
      ":focus-visible": focusVars["--focus-outline-width"],
    },
    outlineColor: {
      default: null,
      ":focus-visible": colorVars["--color-info"],
    },
  },
  sessionButtonSelected: {
    backgroundColor: {
      default: colorVars["--color-accent-muted"],
      ":hover": colorVars["--color-accent-muted"],
    },
    fontWeight: fontWeightVars["--font-weight-medium"],
    color: colorVars["--color-text-primary"],
  },
  itemLabelGroup: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: spacingVars["--spacing-2"],
  },
  botIcon: {
    width: "1rem",
    height: "1rem",
    flexShrink: 0,
    color: colorVars["--color-icon-accent"],
  },
  sessionIcon: {
    width: "0.875rem",
    height: "0.875rem",
    flexShrink: 0,
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  engineTag: {
    fontFamily: typographyVars["--font-family-code"],
    fontSize: textSizeVars["--font-size-sm"],
    color: colorVars["--color-text-secondary"],
  },
  dialogFields: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-4"],
  },
  fieldset: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-2"],
  },
  legend: {
    fontSize: textSizeVars["--font-size-base"],
    fontWeight: fontWeightVars["--font-weight-medium"],
    color: colorVars["--color-text-primary"],
  },
  checkboxRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: spacingVars["--spacing-3"],
  },
  policyRow: {
    display: "flex",
    alignItems: "center",
    gap: spacingVars["--spacing-2"],
  },
  monoControl: {
    fontFamily: typographyVars["--font-family-code"],
    fontSize: textSizeVars["--font-size-sm"],
  },
  dialogFooterActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: spacingVars["--spacing-2"],
  },
  iconSm: {
    width: "0.875rem",
    height: "0.875rem",
  },
});

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
  const queryClient = useQueryClient();

  const [botDialogOpen, setBotDialogOpen] = useState(false);
  const [editingBot, setEditingBot] = useState<Bot | null>(null);
  const [botName, setBotName] = useState("");
  const [botPersona, setBotPersona] = useState("");
  const [botDefaultEngine, setBotDefaultEngine] = useState<EngineKind>("fixture");
  const [botAllowedEngines, setBotAllowedEngines] = useState<EngineKind[]>(["fixture"]);
  const [botWorkspacePath, setBotWorkspacePath] = useState("");
  const [policyRows, setPolicyRows] = useState<PolicyRow[]>([]);
  const nextPolicyRowId = useRef(0);
  const [botProblem, setBotProblem] = useState<ProblemDetails | null>(null);

  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [sessionTitle, setSessionTitle] = useState("");
  const [sessionEngine, setSessionEngine] = useState<string>("default");
  const [sessionProblem, setSessionProblem] = useState<ProblemDetails | null>(null);

  const selectedBot = bots.find((entry) => entry.id === selectedBotId) ?? null;

  const saveBotMutation = useMutation({
    mutationFn: (
      variables:
        | { readonly editingBotId: string; readonly input: UpdateBotInput }
        | { readonly editingBotId: null; readonly input: CreateBotInput },
    ) =>
      variables.editingBotId !== null
        ? api.updateBot(variables.editingBotId, variables.input)
        : api.createBot(variables.input),
    onSuccess: async (saved, variables) => {
      const key = consoleQueryKeys.bots();
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<Bot[]>(key, (prev) => {
        if (!prev) {
          return [saved];
        }
        return prev.some((entry) => entry.id === saved.id)
          ? prev.map((entry) => (entry.id === saved.id ? saved : entry))
          : [...prev, saved];
      });
      onBotSaved(saved);
      onAnnounce(
        variables.editingBotId !== null
          ? `Updated bot ${saved.name}.`
          : `Created bot ${saved.name}.`,
      );
      setBotDialogOpen(false);
    },
    onError: (error, variables) => {
      setBotProblem(
        toOperatorProblem(
          error,
          variables.editingBotId !== null ? `/api/bots/${variables.editingBotId}` : "/api/bots",
        ),
      );
    },
  });

  const createSessionMutation = useMutation({
    mutationFn: ({
      botId,
      input,
    }: {
      readonly botId: string;
      readonly input: CreateSessionPayload;
    }) => api.createSession(botId, input),
    onSuccess: async (created) => {
      const key = consoleQueryKeys.sessions(created.botId);
      await queryClient.cancelQueries({ queryKey: key });
      const hadList = queryClient.getQueryData<Session[]>(key) !== undefined;
      queryClient.setQueryData<Session[]>(key, (prev) => {
        if (!prev) {
          return [created];
        }
        return prev.some((entry) => entry.id === created.id) ? prev : [...prev, created];
      });
      if (!hadList) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      onSessionCreated(created);
      onAnnounce(`Created session ${created.title}.`);
      setSessionDialogOpen(false);
    },
    onError: (error, variables) => {
      setSessionProblem(toOperatorProblem(error, `/api/bots/${variables.botId}/sessions`));
    },
  });

  const botSaving = saveBotMutation.isPending;
  const sessionSaving = createSessionMutation.isPending;

  function openCreateBot() {
    setEditingBot(null);
    setBotName("");
    setBotPersona("");
    setBotDefaultEngine("fixture");
    setBotAllowedEngines(["fixture"]);
    setBotWorkspacePath("");
    setPolicyRows([]);
    setBotProblem(null);
    setBotDialogOpen(true);
  }

  function addPolicyRow(selector = "", decision: PolicyDecision = "ask"): PolicyRow {
    nextPolicyRowId.current += 1;
    return { id: nextPolicyRowId.current, selector, decision };
  }

  function updatePolicyRow(id: number, change: Partial<Omit<PolicyRow, "id">>) {
    setPolicyRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...change } : row)));
  }

  function openEditBot(target: Bot) {
    setEditingBot(target);
    setBotName(target.name);
    setBotPersona(target.persona);
    setBotDefaultEngine(target.defaultEngine);
    setBotAllowedEngines([...target.allowedEngines]);
    setBotWorkspacePath(target.workspacePath ?? "");
    setPolicyRows(
      Object.entries(target.capabilityPolicy).map(([selector, decision]) =>
        addPolicyRow(selector, decision),
      ),
    );
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

  function handleBotSubmit(event: FormEvent) {
    event.preventDefault();
    if (botName.trim().length === 0) {
      return;
    }
    setBotProblem(null);
    const allowed = botAllowedEngines.includes(botDefaultEngine)
      ? botAllowedEngines
      : [...botAllowedEngines, botDefaultEngine];
    const trimmedWorkspace = botWorkspacePath.trim();
    const capabilityPolicy = policyFromRows(policyRows);
    const input = {
      name: botName.trim(),
      persona: botPersona,
      defaultEngine: botDefaultEngine,
      allowedEngines: allowed,
      capabilityPolicy,
      ...(trimmedWorkspace.length > 0 ? { workspacePath: trimmedWorkspace } : {}),
    };
    saveBotMutation.mutate(
      editingBot !== null ? { editingBotId: editingBot.id, input } : { editingBotId: null, input },
    );
  }

  function openCreateSession() {
    setSessionTitle("");
    setSessionEngine("default");
    setSessionProblem(null);
    setSessionDialogOpen(true);
  }

  function handleSessionSubmit(event: FormEvent) {
    event.preventDefault();
    if (!selectedBot || sessionTitle.trim().length === 0) {
      return;
    }
    setSessionProblem(null);
    createSessionMutation.mutate({
      botId: selectedBot.id,
      input: {
        title: sessionTitle.trim(),
        ...(sessionEngine !== "default" ? { engine: sessionEngine as EngineKind } : {}),
      },
    });
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
    <aside aria-label="Bots and sessions" {...stylex.props(styles.sidebar)}>
      <div {...stylex.props(styles.brandHeader)}>
        <div {...stylex.props(styles.brandIdentity)}>
          <img src="/der-mark.svg" alt="" {...stylex.props(styles.brandMark)} />
          <div {...stylex.props(styles.brandText)}>
            <span {...stylex.props(styles.brandTitle)}>der</span>
            <Text type="supporting">Operator console</Text>
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          label="New bot"
          icon={<PlusIcon {...stylex.props(styles.iconSm)} aria-hidden="true" />}
          onClick={openCreateBot}
        />
      </div>

      <Divider />

      <div {...stylex.props(styles.scrollArea)}>
        <section aria-labelledby="sidebar-bots-heading" {...stylex.props(styles.section)}>
          <div {...stylex.props(styles.sectionHeader)}>
            <Heading level={2} id="sidebar-bots-heading" color="secondary">
              Bots ({bots.length})
            </Heading>
          </div>

          {bots.length === 0 ? (
            <Text type="supporting" as="p" xstyle={styles.emptyHint}>
              No bots yet. Create one to start a scoped session.
            </Text>
          ) : (
            <ul {...stylex.props(styles.list)}>
              {bots.map((entry) => {
                const isSelected = entry.id === selectedBotId;
                return (
                  <li key={entry.id} {...stylex.props(styles.botListItem)}>
                    <button
                      type="button"
                      onClick={() => onSelectBot(entry.id)}
                      aria-current={isSelected ? "true" : undefined}
                      {...stylex.props(styles.botButton, isSelected && styles.botButtonSelected)}
                    >
                      <span {...stylex.props(styles.itemLabelGroup)}>
                        <BotIcon {...stylex.props(styles.botIcon)} aria-hidden="true" />
                        <span {...stylex.props(styles.truncate)}>{entry.name}</span>
                      </span>
                      <Badge variant="neutral" label={entry.defaultEngine} />
                    </button>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      label={`Edit bot ${entry.name}`}
                      icon={<PencilIcon {...stylex.props(styles.iconSm)} aria-hidden="true" />}
                      onClick={() => openEditBot(entry)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <Divider />

        <section aria-labelledby="sidebar-sessions-heading" {...stylex.props(styles.section)}>
          <div {...stylex.props(styles.sectionHeader)}>
            <Heading level={2} id="sidebar-sessions-heading" color="secondary">
              Sessions ({sessions.length})
            </Heading>
            <Button
              size="sm"
              variant="ghost"
              label="New session"
              icon={<PlusIcon {...stylex.props(styles.iconSm)} aria-hidden="true" />}
              isDisabled={!selectedBot}
              onClick={openCreateSession}
            />
          </div>

          {!selectedBot ? (
            <Text type="supporting" as="p" xstyle={styles.emptyHint}>
              Select a bot to inspect its sessions.
            </Text>
          ) : sessions.length === 0 ? (
            <Text type="supporting" as="p" xstyle={styles.emptyHint}>
              No sessions in {selectedBot.name}.
            </Text>
          ) : (
            <ul {...stylex.props(styles.list)}>
              {sessions.map((entry) => {
                const isSelected = entry.id === selectedSessionId;
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => onSelectSession(entry.id)}
                      aria-current={isSelected ? "true" : undefined}
                      {...stylex.props(
                        styles.sessionButton,
                        isSelected && styles.sessionButtonSelected,
                      )}
                    >
                      <span {...stylex.props(styles.itemLabelGroup)}>
                        <MessageSquareIcon
                          {...stylex.props(styles.sessionIcon)}
                          aria-hidden="true"
                        />
                        <span {...stylex.props(styles.truncate)}>{entry.title}</span>
                      </span>
                      {entry.pendingEventCount ? (
                        <span
                          data-pending-events={entry.pendingEventCount}
                          {...stylex.props(styles.engineTag)}
                        >
                          {entry.pendingEventCount} waiting
                        </span>
                      ) : null}
                      {entry.engine ? (
                        <span {...stylex.props(styles.engineTag)}>{entry.engine}</span>
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
                <div {...stylex.props(styles.dialogFields)}>
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

                  <fieldset {...stylex.props(styles.fieldset)}>
                    <legend {...stylex.props(styles.legend)}>Allowed engines</legend>
                    <Text type="supporting" as="p">
                      Sessions and runs for this bot can only use checked engines.
                    </Text>
                    <div {...stylex.props(styles.checkboxRow)}>
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
                    controlXstyle={styles.monoControl}
                  />

                  <fieldset {...stylex.props(styles.fieldset)}>
                    <legend {...stylex.props(styles.legend)}>Capability policy</legend>
                    <Text type="supporting" as="p">
                      Set allow, ask or deny for a capability id or a namespace such as mcp.github.
                      The most specific rule wins; no rule keeps the capability's own approval
                      setting.
                    </Text>
                    {policyRows.map((row, index) => (
                      <div key={row.id} {...stylex.props(styles.policyRow)}>
                        <TextInput
                          label={`Policy selector ${index + 1}`}
                          isLabelHidden
                          value={row.selector}
                          onChange={(value) => updatePolicyRow(row.id, { selector: value })}
                          placeholder="notes.publish or mcp.github"
                          width="100%"
                          controlXstyle={styles.monoControl}
                        />
                        <Selector
                          label={`Policy decision ${index + 1}`}
                          isLabelHidden
                          value={row.decision}
                          options={POLICY_DECISION_OPTIONS}
                          onChange={(value) =>
                            updatePolicyRow(row.id, { decision: value as PolicyDecision })
                          }
                          width="7rem"
                        />
                        <IconButton
                          label={`Remove policy rule ${index + 1}`}
                          icon={<Trash2Icon {...stylex.props(styles.iconSm)} aria-hidden="true" />}
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setPolicyRows((rows) => rows.filter((r) => r.id !== row.id))
                          }
                        />
                      </div>
                    ))}
                    <div>
                      <Button
                        variant="secondary"
                        label="Add policy rule"
                        onClick={() => setPolicyRows((rows) => [...rows, addPolicyRow()])}
                      />
                    </div>
                  </fieldset>
                </div>
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <div {...stylex.props(styles.dialogFooterActions)}>
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
                <div {...stylex.props(styles.dialogFields)}>
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
                <div {...stylex.props(styles.dialogFooterActions)}>
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
