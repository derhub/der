import { CheckCircle2Icon, RefreshCwIcon, ShieldAlertIcon, WrenchIcon } from "lucide-react";
import type { EngineReadiness, ProblemDetails, ToolDescriptor } from "@der/domain";
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
import type { HealthResponse } from "@/lib/schemas";

export interface ReadinessPanelProps {
  readonly health: HealthResponse | null;
  readonly engines: readonly EngineReadiness[];
  readonly tools: readonly ToolDescriptor[];
  readonly loading: boolean;
  readonly problem: ProblemDetails | null;
  readonly onRefresh: () => void;
}

function interactiveBadgeVariant(
  state: EngineReadiness["interactive"],
): "ready" | "warn" | "danger" {
  if (state === "ready") return "ready";
  if (state === "login_required") return "warn";
  return "danger";
}

function unattendedBadgeVariant(state: EngineReadiness["unattended"]): "ready" | "warn" | "danger" {
  if (state === "ready") return "ready";
  if (state === "unverified") return "warn";
  return "danger";
}

export function ReadinessPanel({
  health,
  engines,
  tools,
  loading,
  problem,
  onRefresh,
}: ReadinessPanelProps) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-base font-semibold tracking-tight">Readiness and host tools</h2>
          <p className="text-xs text-muted-foreground">
            Server process health, rootless sandbox isolation verification, and BYO engine
            eligibility.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCwIcon data-icon="inline-start" />
          {loading ? "Checking..." : "Refresh diagnostics"}
        </Button>
      </div>

      {problem ? <ProblemAlert problem={problem} onRetry={onRefresh} /> : null}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Process health</CardTitle>
            <Badge variant={health?.status === "ok" ? "ready" : "danger"}>
              {health?.status === "ok" ? "Healthy" : "Unavailable"}
            </Badge>
          </div>
          <CardDescription>
            {health
              ? `Last server clock reading: ${health.timestamp}`
              : "Health check has not succeeded yet."}
          </CardDescription>
        </CardHeader>
      </Card>

      <section aria-labelledby="engines-heading" className="flex flex-col gap-3">
        <h3 id="engines-heading" className="text-sm font-semibold">
          BYO engines ({engines.length})
        </h3>
        {engines.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia>
                <ShieldAlertIcon />
              </EmptyMedia>
              <EmptyTitle>No engines reported</EmptyTitle>
              <EmptyDescription>
                Check server configuration for enabled BYO engines or fixture mode.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {engines.map((entry) => (
              <Card key={entry.engine}>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="font-mono">{entry.engine}</CardTitle>
                    <Badge variant={entry.isolationVerified ? "ready" : "danger"}>
                      {entry.isolationVerified ? (
                        <CheckCircle2Icon aria-hidden="true" />
                      ) : (
                        <ShieldAlertIcon aria-hidden="true" />
                      )}
                      {entry.isolationVerified ? "Isolation verified" : "Isolation blocked"}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Badge variant={interactiveBadgeVariant(entry.interactive)}>
                      Interactive: {entry.interactive}
                    </Badge>
                    <Badge variant={unattendedBadgeVariant(entry.unattended)}>
                      Unattended: {entry.unattended}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {entry.reasons.length > 0 ? (
                    <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                      {entry.reasons.map((reason, idx) => (
                        <li key={`${entry.engine}-reason-${idx}`} className="leading-relaxed">
                          {reason}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      All readiness and isolation checks passed.
                    </p>
                  )}

                  {entry.loginGuidance ? (
                    <div className="rounded-md border border-status-warn/30 bg-status-warn-surface px-3 py-2 text-xs text-status-warn">
                      <p className="font-medium">Login guidance</p>
                      <p className="mt-1 font-mono text-[11px] break-all">{entry.loginGuidance}</p>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="tools-heading" className="flex flex-col gap-3">
        <h3 id="tools-heading" className="text-sm font-semibold">
          Registered host tools ({tools.length})
        </h3>
        {tools.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia>
                <WrenchIcon />
              </EmptyMedia>
              <EmptyTitle>No host tools registered</EmptyTitle>
              <EmptyDescription>
                Configure MCP servers, Home Assistant, Docker, or Wasmer tools on the server.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {tools.map((tool) => (
              <Card key={`${tool.kind}:${tool.id}`}>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle>{tool.name}</CardTitle>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="secondary" className="font-mono">
                        {tool.kind}
                      </Badge>
                      <Badge variant={tool.requiresApproval ? "warn" : "ready"}>
                        {tool.requiresApproval ? "Approval required" : "Read-only"}
                      </Badge>
                    </div>
                  </div>
                  <CardDescription className="font-mono text-[11px]">{tool.id}</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {tool.description}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
