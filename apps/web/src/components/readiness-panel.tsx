import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { CheckCircle2Icon, RefreshCwIcon, ShieldAlertIcon, WrenchIcon } from "lucide-react";
import type { EngineReadiness, ProblemDetails, ToolDescriptor } from "@der/domain";
import { ProblemAlert } from "@/components/problem-alert";
import type { HealthResponse } from "@/lib/schemas";

export interface ReadinessPanelProps {
  readonly health: HealthResponse | null;
  readonly engines: readonly EngineReadiness[];
  readonly tools: readonly ToolDescriptor[];
  readonly loading: boolean;
  readonly problem: ProblemDetails | null;
  readonly onRefresh: () => void;
}

function interactiveBadgeVariant(state: EngineReadiness["interactive"]): BadgeVariant {
  if (state === "ready") return "success";
  if (state === "login_required") return "warning";
  return "error";
}

function unattendedBadgeVariant(state: EngineReadiness["unattended"]): BadgeVariant {
  if (state === "ready") return "success";
  if (state === "unverified") return "warning";
  return "error";
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
          <Heading level={2}>Readiness and host tools</Heading>
          <Text type="supporting" as="p">
            Server process health, rootless sandbox isolation verification, and BYO engine
            eligibility.
          </Text>
        </div>
        <Button
          variant="secondary"
          size="sm"
          label={loading ? "Checking..." : "Refresh diagnostics"}
          icon={<RefreshCwIcon className="size-3.5" aria-hidden="true" />}
          isDisabled={loading}
          onClick={onRefresh}
        />
      </div>

      {problem ? <ProblemAlert problem={problem} onRetry={onRefresh} /> : null}

      <Card>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Heading level={3}>Process health</Heading>
            <Badge
              variant={health?.status === "ok" ? "success" : "error"}
              label={health?.status === "ok" ? "Healthy" : "Unavailable"}
            />
          </div>
          <Text type="supporting" as="p">
            {health
              ? `Last server clock reading: ${health.timestamp}`
              : "Health check has not succeeded yet."}
          </Text>
        </div>
      </Card>

      <section aria-labelledby="engines-heading" className="flex flex-col gap-3">
        <Heading level={3} id="engines-heading">
          BYO engines ({engines.length})
        </Heading>
        {engines.length === 0 ? (
          <EmptyState
            icon={<ShieldAlertIcon className="size-6" aria-hidden="true" />}
            title="No engines reported"
            description="Check server configuration for enabled BYO engines or fixture mode."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {engines.map((entry) => (
              <Card key={entry.engine}>
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Text type="code" weight="semibold">
                      {entry.engine}
                    </Text>
                    <Badge
                      variant={entry.isolationVerified ? "success" : "error"}
                      icon={
                        entry.isolationVerified ? (
                          <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
                        ) : (
                          <ShieldAlertIcon className="size-3.5" aria-hidden="true" />
                        )
                      }
                      label={entry.isolationVerified ? "Isolation verified" : "Isolation blocked"}
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={interactiveBadgeVariant(entry.interactive)}
                      label={`Interactive: ${entry.interactive}`}
                    />
                    <Badge
                      variant={unattendedBadgeVariant(entry.unattended)}
                      label={`Unattended: ${entry.unattended}`}
                    />
                  </div>

                  {entry.reasons.length > 0 ? (
                    <ul className="flex flex-col gap-1 text-xs text-secondary">
                      {entry.reasons.map((reason, idx) => (
                        <li key={`${entry.engine}-reason-${idx}`} className="leading-relaxed">
                          {reason}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Text type="supporting" as="p">
                      All readiness and isolation checks passed.
                    </Text>
                  )}

                  {entry.loginGuidance ? (
                    <div className="rounded-md border border-warning bg-warning-muted px-3 py-2 text-xs text-on-warning-muted">
                      <p className="font-medium">Login guidance</p>
                      <p className="mt-1 font-mono text-xs break-all">{entry.loginGuidance}</p>
                    </div>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="tools-heading" className="flex flex-col gap-3">
        <Heading level={3} id="tools-heading">
          Registered host tools ({tools.length})
        </Heading>
        {tools.length === 0 ? (
          <EmptyState
            icon={<WrenchIcon className="size-6" aria-hidden="true" />}
            title="No host tools registered"
            description="Configure MCP servers, Docker, or Wasmer tools on the server."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {tools.map((tool) => (
              <Card key={`${tool.kind}:${tool.id}`}>
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Heading level={4}>{tool.name}</Heading>
                    <div className="flex items-center gap-1.5">
                      <Badge variant="neutral" label={tool.kind} />
                      <Badge
                        variant={tool.requiresApproval ? "warning" : "success"}
                        label={tool.requiresApproval ? "Approval required" : "Read-only"}
                      />
                    </div>
                  </div>
                  <Text type="code" color="secondary" as="p">
                    {tool.id}
                  </Text>
                  <Text type="supporting" as="p">
                    {tool.description}
                  </Text>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
