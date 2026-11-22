import { BrainIcon, RefreshCwIcon, SaveIcon } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Bot, ProblemDetails } from "@der/domain";
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
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { OperatorApi } from "@/lib/operator-api";
import { toOperatorProblem, type BotMemoryResponse } from "@/lib/schemas";

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
      <Empty>
        <EmptyHeader>
          <EmptyMedia>
            <BrainIcon />
          </EmptyMedia>
          <EmptyTitle>No bot selected</EmptyTitle>
          <EmptyDescription>
            Select a bot from the sidebar to view or edit its Memory.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const latestVersion = memoryState?.versions[0]?.version;
  const activeVersion = memoryState?.memory?.version;
  const isViewingHistorical =
    selectedVersion !== "latest" &&
    latestVersion !== undefined &&
    activeVersion !== undefined &&
    activeVersion !== latestVersion;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-base font-semibold tracking-tight">Memory for {bot.name}</h2>
          <p className="text-xs text-muted-foreground">
            Authoritative bot-scoped Markdown in SQLite, atomically projected to disk.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="w-44">
            <Select value={selectedVersion} onValueChange={(v) => void handleVersionChange(v)}>
              <SelectTrigger aria-label="Memory version">
                <SelectValue placeholder="Latest version" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="latest">Latest version</SelectItem>
                  {(memoryState?.versions ?? []).map((entry) => (
                    <SelectItem key={entry.version} value={String(entry.version)}>
                      v{entry.version} ({entry.updatedAt.slice(0, 19)}Z)
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void loadMemory(
                bot.id,
                selectedVersion === "latest" ? undefined : Number(selectedVersion),
              )
            }
            disabled={loading}
          >
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
        </div>
      </div>

      {problem ? <ProblemAlert problem={problem} onDismiss={() => setProblem(null)} /> : null}

      <Card>
        <form onSubmit={handleSave}>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Markdown source</CardTitle>
              <div className="flex items-center gap-2">
                {activeVersion !== undefined ? (
                  <Badge variant="secondary" className="font-mono">
                    v{activeVersion}
                  </Badge>
                ) : (
                  <Badge variant="outline">Not written yet</Badge>
                )}
                {isViewingHistorical ? (
                  <Badge variant="warn">Viewing historical revision</Badge>
                ) : null}
              </div>
            </div>
            <CardDescription>
              {memoryState?.memory
                ? `Last updated at ${memoryState.memory.updatedAt}`
                : "Write initial bot memory. Saving uses optimistic concurrency against the latest version."}
            </CardDescription>
          </CardHeader>

          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="bot-memory-editor">Bot memory Markdown</FieldLabel>
                <Textarea
                  id="bot-memory-editor"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={14}
                  placeholder="# Preferences&#10;- Keep answers concise."
                  className="font-mono text-xs leading-relaxed"
                />
                <FieldDescription>
                  Saving writes a new version using expectedVersion={latestVersion ?? 0}.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </CardContent>

          <CardFooter>
            <Button type="submit" disabled={saving || loading}>
              <SaveIcon data-icon="inline-start" />
              {saving ? "Saving..." : "Save memory"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
