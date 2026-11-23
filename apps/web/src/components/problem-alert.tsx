import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import { spacingVars, textSizeVars, typographyVars } from "@astryxdesign/core/theme/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ProblemDetails } from "@der/domain";

const styles = stylex.create({
  titleRow: {
    display: "inline-flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacingVars["--spacing-2"],
  },
  descriptionColumn: {
    display: "flex",
    flexDirection: "column",
    gap: spacingVars["--spacing-1"],
  },
  detailText: {
    overflowWrap: "break-word",
  },
  metaRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacingVars["--spacing-3"],
    fontFamily: typographyVars["--font-family-code"],
    fontSize: textSizeVars["--font-size-sm"],
    opacity: 0.8,
  },
});

export interface ProblemAlertProps {
  readonly problem: ProblemDetails;
  readonly onDismiss?: () => void;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}

export function ProblemAlert({
  problem,
  onDismiss,
  onRetry,
  retryLabel = "Retry",
}: ProblemAlertProps) {
  return (
    <div role="alert" aria-label={problem.title} data-problem-code={problem.code}>
      <Banner
        status="error"
        collapsible={false}
        isDismissable={Boolean(onDismiss)}
        {...(onDismiss ? { onDismiss } : {})}
        dismissLabel="Dismiss error"
        title={
          <span {...stylex.props(styles.titleRow)}>
            <span>{problem.title}</span>
            <Badge variant="error" label={String(problem.status)} />
            <Badge variant="neutral" label={problem.code} />
          </span>
        }
        description={
          <div {...stylex.props(styles.descriptionColumn)}>
            <Text type="body" as="p" xstyle={styles.detailText}>
              {problem.detail}
            </Text>
            <div {...stylex.props(styles.metaRow)}>
              <span>instance: {problem.instance}</span>
              <span>type: {problem.type}</span>
            </div>
          </div>
        }
        endContent={
          onRetry ? (
            <Button size="sm" variant="secondary" label={retryLabel} onClick={onRetry} />
          ) : undefined
        }
      />
    </div>
  );
}
