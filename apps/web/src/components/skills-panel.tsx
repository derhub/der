import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { BookOpenIcon, RefreshCwIcon, ShieldAlertIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ProblemDetails } from "@der/domain";
import { ProblemAlert } from "@/components/problem-alert";
import type { OperatorApi } from "@/lib/operator-api";
import {
  toOperatorProblem,
  type SkillDetailResponse,
  type SkillsCatalogResponse,
} from "@/lib/schemas";
import { cn } from "@/lib/utils";

export interface SkillsPanelProps {
  readonly api: OperatorApi;
}

export function SkillsPanel({ api }: SkillsPanelProps) {
  const [catalog, setCatalog] = useState<SkillsCatalogResponse>({ skills: [], rejected: [] });
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    try {
      const next = await api.listSkills();
      setCatalog(next);
      if (next.skills.length > 0) {
        setSelectedSkillId((current) => {
          if (current && next.skills.some((entry) => entry.id === current)) {
            return current;
          }
          return next.skills[0]?.id ?? null;
        });
      } else {
        setSelectedSkillId(null);
        setDetail(null);
      }
    } catch (error) {
      setProblem(toOperatorProblem(error, "/api/skills"));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    if (!selectedSkillId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    api
      .readSkill(selectedSkillId, controller.signal)
      .then((loaded) => {
        setDetail(loaded);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setProblem(toOperatorProblem(error, `/api/skills/${selectedSkillId}`));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setDetailLoading(false);
        }
      });
    return () => controller.abort();
  }, [api, selectedSkillId]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <Heading level={2}>Skill catalog</Heading>
          <Text type="supporting" as="p">
            Read-only Agent Skills packages validated from the server skills root.
          </Text>
        </div>
        <Button
          variant="secondary"
          size="sm"
          label={loading ? "Reloading..." : "Reload catalog"}
          icon={<RefreshCwIcon className="size-3.5" aria-hidden="true" />}
          isDisabled={loading}
          onClick={() => void loadCatalog()}
        />
      </div>

      {problem ? <ProblemAlert problem={problem} onDismiss={() => setProblem(null)} /> : null}

      {catalog.skills.length === 0 ? (
        <EmptyState
          icon={<BookOpenIcon className="size-6" aria-hidden="true" />}
          title="No valid skills found"
          description="Mount read-only SKILL.md packages into the server skills directory to expose them here."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <ul className="flex flex-col gap-2" aria-label="Available skills">
            {catalog.skills.map((entry) => {
              const isSelected = entry.id === selectedSkillId;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedSkillId(entry.id)}
                    aria-current={isSelected ? "true" : undefined}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-lg border p-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-info",
                      isSelected
                        ? "border-border-strong bg-accent-muted"
                        : "border-border bg-card hover:bg-muted",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-semibold">{entry.name}</span>
                      {entry.license ? <Badge variant="neutral" label={entry.license} /> : null}
                    </div>
                    <p className="text-xs text-secondary leading-relaxed">{entry.description}</p>
                    <span className="font-mono text-xs text-secondary">{entry.relativePath}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          <Card>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <Heading level={3} className="font-mono">
                  {detail?.skill.name ?? selectedSkillId ?? "Skill details"}
                </Heading>
                <Text type="supporting" as="p">
                  {detail?.skill.description ??
                    "Select a skill to inspect its SKILL.md instructions."}
                </Text>
                {detail?.skill.allowedTools && detail.skill.allowedTools.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    {detail.skill.allowedTools.map((tool) => (
                      <Badge key={tool} variant="neutral" label={tool} />
                    ))}
                  </div>
                ) : null}
              </div>

              {detailLoading ? (
                <Text type="supporting" as="p">
                  Loading skill instructions...
                </Text>
              ) : detail ? (
                <pre className="max-h-[30rem] overflow-auto rounded-md border border-border bg-muted p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                  {detail.body || "(Empty SKILL.md body)"}
                </pre>
              ) : null}
            </div>
          </Card>
        </div>
      )}

      {catalog.rejected.length > 0 ? (
        <Card>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <ShieldAlertIcon className="size-4 text-warning" aria-hidden="true" />
                <Heading level={3}>Rejected skill packages ({catalog.rejected.length})</Heading>
              </div>
              <Text type="supporting" as="p">
                Entries rejected by frontmatter or path containment validation.
              </Text>
            </div>
            <ul className="flex flex-col gap-2">
              {catalog.rejected.map((item) => (
                <li
                  key={`${item.relativePath}:${item.reason}`}
                  className="flex flex-col gap-0.5 rounded-md border border-border bg-muted px-3 py-2 text-xs"
                >
                  <span className="font-mono font-medium">{item.relativePath}</span>
                  <span className="text-secondary">{item.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
