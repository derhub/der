import { BookOpenIcon, RefreshCwIcon, ShieldAlertIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ProblemDetails } from "@der/domain";
import { ProblemAlert } from "@/components/problem-alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
          <h2 className="text-base font-semibold tracking-tight">Skill catalog</h2>
          <p className="text-xs text-muted-foreground">
            Read-only Agent Skills packages validated from the server skills root.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void loadCatalog()} disabled={loading}>
          <RefreshCwIcon data-icon="inline-start" />
          {loading ? "Reloading..." : "Reload catalog"}
        </Button>
      </div>

      {problem ? <ProblemAlert problem={problem} onDismiss={() => setProblem(null)} /> : null}

      {catalog.skills.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia>
              <BookOpenIcon />
            </EmptyMedia>
            <EmptyTitle>No valid skills found</EmptyTitle>
            <EmptyDescription>
              Mount read-only SKILL.md packages into the server skills directory to expose them
              here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
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
                      "flex w-full flex-col gap-1 rounded-lg border p-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                      isSelected
                        ? "border-primary bg-accent/60"
                        : "border-border bg-card hover:bg-muted/60",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-semibold">{entry.name}</span>
                      {entry.license ? <Badge variant="secondary">{entry.license}</Badge> : null}
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {entry.description}
                    </p>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {entry.relativePath}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <Card>
            <CardHeader>
              <CardTitle className="font-mono">
                {detail?.skill.name ?? selectedSkillId ?? "Skill details"}
              </CardTitle>
              <CardDescription>
                {detail?.skill.description ??
                  "Select a skill to inspect its SKILL.md instructions."}
              </CardDescription>
              {detail?.skill.allowedTools && detail.skill.allowedTools.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  {detail.skill.allowedTools.map((tool) => (
                    <Badge key={tool} variant="outline" className="font-mono">
                      {tool}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </CardHeader>
            <CardContent>
              {detailLoading ? (
                <p className="text-xs text-muted-foreground">Loading skill instructions...</p>
              ) : detail ? (
                <pre className="max-h-[30rem] overflow-auto rounded-md border border-border bg-muted/50 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                  {detail.body || "(Empty SKILL.md body)"}
                </pre>
              ) : null}
            </CardContent>
          </Card>
        </div>
      )}

      {catalog.rejected.length > 0 ? (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldAlertIcon className="size-4 text-status-warn" aria-hidden="true" />
              <CardTitle>Rejected skill packages ({catalog.rejected.length})</CardTitle>
            </div>
            <CardDescription>
              Entries rejected by frontmatter or path containment validation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2">
              {catalog.rejected.map((item) => (
                <li
                  key={`${item.relativePath}:${item.reason}`}
                  className="flex flex-col gap-0.5 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
                >
                  <span className="font-mono font-medium">{item.relativePath}</span>
                  <span className="text-muted-foreground">{item.reason}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
