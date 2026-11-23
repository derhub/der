import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { spacingVars, textSizeVars, typographyVars } from "@astryxdesign/core/theme/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { BrainIcon, RefreshCwIcon, SaveIcon } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Bot, ProblemDetails } from "@der/domain";
import { ProblemAlert } from "@/components/problem-alert";
import type { OperatorApi } from "@/lib/operator-api";
import { toOperatorProblem, type BotMemoryResponse } from "@/lib/schemas";

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-4"],
  },
  header: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacingVars["--spacing-3"],
  },
  titleGroup: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-0-5"],
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: spacingVars["--spacing-2"],
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-4"],
  },
  cardHeader: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-1"],
  },
  cardHeaderRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacingVars["--spacing-2"],
  },
  badgeRow: {
    display: "flex",
    alignItems: "center",
    gap: spacingVars["--spacing-2"],
  },
  editorControl: {
    fontFamily: typographyVars["--font-family-code"],
    fontSize: textSizeVars["--font-size-sm"],
    lineHeight: 1.625,
  },
  submitRow: {
    display: "flex",
    justifyContent: "flex-end",
  },
  iconSm: {
    width: "0.875rem",
    height: "0.875rem",
  },
  iconMd: {
    width: "1rem",
    height: "1rem",
  },
  iconLg: {
    width: "1.5rem",
    height: "1.5rem",
  },
});

export interface MemoryPanelProps {
  readonly api: OperatorApi;
  readonly bot: Bot | null;
  readonly onAnnounce: (message: string) => void;
}

export function MemoryPanel({ api, bot, onAnnounce }: MemoryPanelProps) {
  const [memoryState, setMemoryState] = useState<BotMemoryResponse | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string>("latest");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);

  const loadMemory = useCallback(
    async (botId: string, version?: number) => {
      setLoading(true);
      setProblem(null);
      try {
        const loaded = await api.readMemory(botId, version);
        setMemoryState(loaded);
        setDraft(loaded.memory?.markdown ?? "");
      } catch (error) {
        setProblem(toOperatorProblem(error, `/api/bots/${botId}/memory`));
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    setSelectedVersion("latest");
    if (!bot) {
      setMemoryState(null);
      setDraft("");
      return;
    }
    void loadMemory(bot.id);
  }, [bot, loadMemory]);

  async function handleVersionChange(value: string) {
    setSelectedVersion(value);
    if (!bot) return;
    const version = value === "latest" ? undefined : Number(value);
    await loadMemory(bot.id, version);
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!bot) return;
    setSaving(true);
    setProblem(null);
    try {
      const latestVersion = memoryState?.versions[0]?.version ?? memoryState?.memory?.version ?? 0;
      const written = await api.writeMemory(bot.id, {
        markdown: draft,
        expectedVersion: latestVersion,
      });
      setSelectedVersion("latest");
      await loadMemory(bot.id);
      onAnnounce(`Saved memory version ${written.version} for ${bot.name}.`);
    } catch (error) {
      setProblem(toOperatorProblem(error, `/api/bots/${bot.id}/memory`));
    } finally {
      setSaving(false);
    }
  }

  if (!bot) {
    return (
      <EmptyState
        icon={<BrainIcon {...stylex.props(styles.iconLg)} aria-hidden="true" />}
        title="No bot selected"
        description="Select a bot from the sidebar to view or edit its Memory."
      />
    );
  }

  const latestVersion = memoryState?.versions[0]?.version;
  const activeVersion = memoryState?.memory?.version;
  const isViewingHistorical =
    selectedVersion !== "latest" &&
    latestVersion !== undefined &&
    activeVersion !== undefined &&
    activeVersion !== latestVersion;

  const versionOptions = [
    { value: "latest", label: "Latest version" },
    ...(memoryState?.versions ?? []).map((entry) => ({
      value: String(entry.version),
      label: `v${entry.version} (${entry.updatedAt.slice(0, 19)}Z)`,
    })),
  ];

  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.titleGroup)}>
          <Heading level={2}>Memory for {bot.name}</Heading>
          <Text type="supporting" as="p">
            Authoritative bot-scoped Markdown in SQLite, atomically projected to disk.
          </Text>
        </div>

        <div {...stylex.props(styles.actions)}>
          <Selector
            label="Memory version"
            isLabelHidden
            size="sm"
            width={192}
            value={selectedVersion}
            options={versionOptions}
            onChange={(value) => void handleVersionChange(value)}
            placeholder="Latest version"
          />

          <Button
            variant="secondary"
            size="sm"
            label="Refresh"
            icon={<RefreshCwIcon {...stylex.props(styles.iconSm)} aria-hidden="true" />}
            isDisabled={loading}
            onClick={() =>
              void loadMemory(
                bot.id,
                selectedVersion === "latest" ? undefined : Number(selectedVersion),
              )
            }
          />
        </div>
      </div>

      {problem ? <ProblemAlert problem={problem} onDismiss={() => setProblem(null)} /> : null}

      <Card>
        <form onSubmit={handleSave} {...stylex.props(styles.form)}>
          <div {...stylex.props(styles.cardHeader)}>
            <div {...stylex.props(styles.cardHeaderRow)}>
              <Heading level={3}>Markdown source</Heading>
              <div {...stylex.props(styles.badgeRow)}>
                {activeVersion !== undefined ? (
                  <Badge variant="neutral" label={`v${activeVersion}`} />
                ) : (
                  <Badge variant="neutral" label="Not written yet" />
                )}
                {isViewingHistorical ? (
                  <Badge variant="warning" label="Viewing historical revision" />
                ) : null}
              </div>
            </div>
            <Text type="supporting" as="p">
              {memoryState?.memory
                ? `Last updated at ${memoryState.memory.updatedAt}`
                : "Write initial bot memory. Saving uses optimistic concurrency against the latest version."}
            </Text>
          </div>

          <TextArea
            id="bot-memory-editor"
            label="Bot memory Markdown"
            description={`Saving writes a new version using expectedVersion=${latestVersion ?? 0}.`}
            value={draft}
            onChange={setDraft}
            rows={14}
            placeholder={"# Preferences\n- Keep answers concise."}
            width="100%"
            controlXstyle={styles.editorControl}
          />

          <div {...stylex.props(styles.submitRow)}>
            <Button
              type="submit"
              variant="primary"
              label={saving ? "Saving..." : "Save memory"}
              icon={<SaveIcon {...stylex.props(styles.iconMd)} aria-hidden="true" />}
              isDisabled={saving || loading}
            />
          </div>
        </form>
      </Card>
    </div>
  );
}
