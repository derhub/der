import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
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
import { CheckCircle2Icon, RefreshCwIcon, ShieldAlertIcon, WrenchIcon } from "lucide-react";
import type { CapabilityDescriptor, EngineReadiness, ProblemDetails } from "@der/domain";
import { ProblemAlert } from "@/components/problem-alert";
import type { HealthResponse } from "@/lib/schemas";

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-5"],
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
  healthCard: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-1-5"],
  },
  rowBetween: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacingVars["--spacing-2"],
  },
  rowBetweenWrap: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacingVars["--spacing-2"],
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-3"],
  },
  cardGrid: {
    display: "grid",
    gap: spacingVars["--spacing-3"],
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      "@media (min-width: 768px)": "repeat(2, minmax(0, 1fr))",
    },
  },
  engineCard: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-3"],
  },
  toolCard: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-2"],
  },
  badgeRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacingVars["--spacing-2"],
  },
  toolBadges: {
    display: "flex",
    alignItems: "center",
    gap: spacingVars["--spacing-1-5"],
  },
  reasonList: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-1"],
    fontSize: textSizeVars["--font-size-sm"],
    color: colorVars["--color-text-secondary"],
  },
  reasonItem: {
    lineHeight: 1.625,
  },
  loginGuidance: {
    borderRadius: radiusVars["--radius-element"],
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colorVars["--color-border-warning"],
    backgroundColor: colorVars["--color-warning-muted"],
    paddingInline: spacingVars["--spacing-3"],
    paddingBlock: spacingVars["--spacing-2"],
    fontSize: textSizeVars["--font-size-sm"],
    color: colorVars["--color-on-warning-muted"],
  },
  loginGuidanceTitle: {
    fontWeight: fontWeightVars["--font-weight-medium"],
  },
  loginGuidanceCommand: {
    marginTop: spacingVars["--spacing-1"],
    fontFamily: typographyVars["--font-family-code"],
    fontSize: textSizeVars["--font-size-sm"],
    wordBreak: "break-all",
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

export interface ReadinessPanelProps {
  readonly health: HealthResponse | null;
  readonly engines: readonly EngineReadiness[];
  readonly capabilities: readonly CapabilityDescriptor[];
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

function groupByNamespace(
  capabilities: readonly CapabilityDescriptor[],
): Array<[string, CapabilityDescriptor[]]> {
  const groups = new Map<string, CapabilityDescriptor[]>();
  for (const capability of capabilities) {
    const namespace = capability.id.split(".")[0] ?? capability.id;
    groups.set(namespace, [...(groups.get(namespace) ?? []), capability]);
  }
  return [...groups];
}

export function ReadinessPanel({
  health,
  engines,
  capabilities,
  loading,
  problem,
  onRefresh,
}: ReadinessPanelProps) {
  return (
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.titleGroup)}>
          <Heading level={2}>Readiness and capabilities</Heading>
          <Text type="supporting" as="p">
            Server process health, rootless sandbox isolation verification, and BYO engine
            eligibility.
          </Text>
        </div>
        <Button
          variant="secondary"
          size="sm"
          label={loading ? "Checking..." : "Refresh diagnostics"}
          icon={<RefreshCwIcon {...stylex.props(styles.iconSm)} aria-hidden="true" />}
          isDisabled={loading}
          onClick={onRefresh}
        />
      </div>

      {problem ? <ProblemAlert problem={problem} onRetry={onRefresh} /> : null}

      <Card>
        <div {...stylex.props(styles.healthCard)}>
          <div {...stylex.props(styles.rowBetween)}>
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

      <section aria-labelledby="engines-heading" {...stylex.props(styles.section)}>
        <Heading level={3} id="engines-heading">
          BYO engines ({engines.length})
        </Heading>
        {engines.length === 0 ? (
          <EmptyState
            icon={<ShieldAlertIcon {...stylex.props(styles.iconLg)} aria-hidden="true" />}
            title="No engines reported"
            description="Check server configuration for enabled BYO engines or fixture mode."
          />
        ) : (
          <div {...stylex.props(styles.cardGrid)}>
            {engines.map((entry) => (
              <Card key={entry.engine}>
                <div {...stylex.props(styles.engineCard)}>
                  <div {...stylex.props(styles.rowBetweenWrap)}>
                    <Text type="code" weight="semibold">
                      {entry.engine}
                    </Text>
                    <Badge
                      variant={entry.isolationVerified ? "success" : "error"}
                      icon={
                        entry.isolationVerified ? (
                          <CheckCircle2Icon {...stylex.props(styles.iconSm)} aria-hidden="true" />
                        ) : (
                          <ShieldAlertIcon {...stylex.props(styles.iconSm)} aria-hidden="true" />
                        )
                      }
                      label={entry.isolationVerified ? "Isolation verified" : "Isolation blocked"}
                    />
                  </div>

                  <div {...stylex.props(styles.badgeRow)}>
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
                    <ul {...stylex.props(styles.reasonList)}>
                      {entry.reasons.map((reason, idx) => (
                        <li
                          key={`${entry.engine}-reason-${idx}`}
                          {...stylex.props(styles.reasonItem)}
                        >
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
                    <div {...stylex.props(styles.loginGuidance)}>
                      <p {...stylex.props(styles.loginGuidanceTitle)}>Login guidance</p>
                      <p {...stylex.props(styles.loginGuidanceCommand)}>{entry.loginGuidance}</p>
                    </div>
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="capabilities-heading" {...stylex.props(styles.section)}>
        <Heading level={3} id="capabilities-heading">
          Capabilities ({capabilities.length})
        </Heading>
        {capabilities.length === 0 ? (
          <EmptyState
            icon={<WrenchIcon {...stylex.props(styles.iconLg)} aria-hidden="true" />}
            title="No capabilities registered"
            description="Configure capability sources on the server."
          />
        ) : (
          groupByNamespace(capabilities).map(([namespace, group]) => (
            <section
              key={namespace}
              aria-labelledby={`capabilities-${namespace}`}
              {...stylex.props(styles.section)}
            >
              <Heading level={4} id={`capabilities-${namespace}`}>
                {namespace}
              </Heading>
              <div {...stylex.props(styles.cardGrid)}>
                {group.map((capability) => (
                  <Card key={capability.id}>
                    <div {...stylex.props(styles.toolCard)}>
                      <div {...stylex.props(styles.rowBetweenWrap)}>
                        <Text type="code" weight="semibold">
                          {capability.id}
                        </Text>
                        <div {...stylex.props(styles.toolBadges)}>
                          <Badge variant="neutral" label={capability.effect} />
                          <Badge
                            variant={capability.requiresApproval ? "warning" : "success"}
                            label={
                              capability.requiresApproval ? "Approval required" : "No approval"
                            }
                          />
                        </div>
                      </div>
                      <Text type="supporting" as="p">
                        {capability.description}
                      </Text>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          ))
        )}
      </section>
    </div>
  );
}
