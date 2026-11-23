import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import {
  colorVars,
  durationVars,
  easeVars,
  focusVars,
  fontWeightVars,
  radiusVars,
  spacingVars,
  textSizeVars,
  typographyVars,
} from "@astryxdesign/core/theme/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
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
  splitGrid: {
    display: "grid",
    gap: spacingVars["--spacing-4"],
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      "@media (min-width: 1024px)": "20rem minmax(0, 1fr)",
    },
  },
  skillList: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-2"],
  },
  skillButton: {
    display: "flex",
    width: "100%",
    flexDirection: "column",
    gap: spacingVars["--spacing-1"],
    borderRadius: radiusVars["--radius-container"],
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colorVars["--color-border"],
    backgroundColor: {
      default: colorVars["--color-background-card"],
      ":hover": colorVars["--color-background-muted"],
    },
    paddingInline: "0.875rem",
    paddingBlock: "0.875rem",
    textAlign: "left",
    transitionProperty: "color, background-color, border-color",
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
  skillButtonSelected: {
    borderColor: colorVars["--color-border-emphasized"],
    backgroundColor: {
      default: colorVars["--color-accent-muted"],
      ":hover": colorVars["--color-accent-muted"],
    },
  },
  skillRowHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacingVars["--spacing-2"],
  },
  skillName: {
    fontFamily: typographyVars["--font-family-code"],
    fontSize: textSizeVars["--font-size-base"],
    fontWeight: fontWeightVars["--font-weight-semibold"],
  },
  skillDescription: {
    fontSize: textSizeVars["--font-size-sm"],
    color: colorVars["--color-text-secondary"],
    lineHeight: 1.625,
  },
  skillPath: {
    fontFamily: typographyVars["--font-family-code"],
    fontSize: textSizeVars["--font-size-sm"],
    color: colorVars["--color-text-secondary"],
  },
  detailCard: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-3"],
  },
  detailHeader: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-1"],
  },
  monoHeading: {
    fontFamily: typographyVars["--font-family-code"],
  },
  toolBadges: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacingVars["--spacing-1-5"],
    paddingTop: spacingVars["--spacing-1"],
  },
  skillBody: {
    maxHeight: "30rem",
    overflow: "auto",
    borderRadius: radiusVars["--radius-element"],
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colorVars["--color-border"],
    backgroundColor: colorVars["--color-background-muted"],
    paddingInline: spacingVars["--spacing-4"],
    paddingBlock: spacingVars["--spacing-4"],
    fontFamily: typographyVars["--font-family-code"],
    fontSize: textSizeVars["--font-size-sm"],
    lineHeight: 1.625,
    whiteSpace: "pre-wrap",
  },
  rejectedHeadingRow: {
    display: "flex",
    alignItems: "center",
    gap: spacingVars["--spacing-2"],
  },
  warningIcon: {
    width: "1rem",
    height: "1rem",
    color: colorVars["--color-icon-warning"],
  },
  rejectedList: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-2"],
  },
  rejectedItem: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-0-5"],
    borderRadius: radiusVars["--radius-element"],
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colorVars["--color-border"],
    backgroundColor: colorVars["--color-background-muted"],
    paddingInline: spacingVars["--spacing-3"],
    paddingBlock: spacingVars["--spacing-2"],
    fontSize: textSizeVars["--font-size-sm"],
  },
  rejectedPath: {
    fontFamily: typographyVars["--font-family-code"],
    fontWeight: fontWeightVars["--font-weight-medium"],
  },
  rejectedReason: {
    color: colorVars["--color-text-secondary"],
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
    <div {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.titleGroup)}>
          <Heading level={2}>Skill catalog</Heading>
          <Text type="supporting" as="p">
            Read-only Agent Skills packages validated from the server skills root.
          </Text>
        </div>
        <Button
          variant="secondary"
          size="sm"
          label={loading ? "Reloading..." : "Reload catalog"}
          icon={<RefreshCwIcon {...stylex.props(styles.iconSm)} aria-hidden="true" />}
          isDisabled={loading}
          onClick={() => void loadCatalog()}
        />
      </div>

      {problem ? <ProblemAlert problem={problem} onDismiss={() => setProblem(null)} /> : null}

      {catalog.skills.length === 0 ? (
        <EmptyState
          icon={<BookOpenIcon {...stylex.props(styles.iconLg)} aria-hidden="true" />}
          title="No valid skills found"
          description="Mount read-only SKILL.md packages into the server skills directory to expose them here."
        />
      ) : (
        <div {...stylex.props(styles.splitGrid)}>
          <ul {...stylex.props(styles.skillList)} aria-label="Available skills">
            {catalog.skills.map((entry) => {
              const isSelected = entry.id === selectedSkillId;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedSkillId(entry.id)}
                    aria-current={isSelected ? "true" : undefined}
                    {...stylex.props(styles.skillButton, isSelected && styles.skillButtonSelected)}
                  >
                    <div {...stylex.props(styles.skillRowHeader)}>
                      <span {...stylex.props(styles.skillName)}>{entry.name}</span>
                      {entry.license ? <Badge variant="neutral" label={entry.license} /> : null}
                    </div>
                    <p {...stylex.props(styles.skillDescription)}>{entry.description}</p>
                    <span {...stylex.props(styles.skillPath)}>{entry.relativePath}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          <Card>
            <div {...stylex.props(styles.detailCard)}>
              <div {...stylex.props(styles.detailHeader)}>
                <Heading level={3} xstyle={styles.monoHeading}>
                  {detail?.skill.name ?? selectedSkillId ?? "Skill details"}
                </Heading>
                <Text type="supporting" as="p">
                  {detail?.skill.description ??
                    "Select a skill to inspect its SKILL.md instructions."}
                </Text>
                {detail?.skill.allowedTools && detail.skill.allowedTools.length > 0 ? (
                  <div {...stylex.props(styles.toolBadges)}>
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
                <pre {...stylex.props(styles.skillBody)}>
                  {detail.body || "(Empty SKILL.md body)"}
                </pre>
              ) : null}
            </div>
          </Card>
        </div>
      )}

      {catalog.rejected.length > 0 ? (
        <Card>
          <div {...stylex.props(styles.detailCard)}>
            <div {...stylex.props(styles.detailHeader)}>
              <div {...stylex.props(styles.rejectedHeadingRow)}>
                <ShieldAlertIcon {...stylex.props(styles.warningIcon)} aria-hidden="true" />
                <Heading level={3}>Rejected skill packages ({catalog.rejected.length})</Heading>
              </div>
              <Text type="supporting" as="p">
                Entries rejected by frontmatter or path containment validation.
              </Text>
            </div>
            <ul {...stylex.props(styles.rejectedList)}>
              {catalog.rejected.map((item) => (
                <li
                  key={`${item.relativePath}:${item.reason}`}
                  {...stylex.props(styles.rejectedItem)}
                >
                  <span {...stylex.props(styles.rejectedPath)}>{item.relativePath}</span>
                  <span {...stylex.props(styles.rejectedReason)}>{item.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
