import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Text } from "@astryxdesign/core/Text";
import type { ProblemDetails } from "@der/domain";

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
          <span className="inline-flex flex-wrap items-center gap-2">
            <span>{problem.title}</span>
            <Badge variant="error" label={String(problem.status)} />
            <Badge variant="neutral" label={problem.code} />
          </span>
        }
        description={
          <div className="flex flex-col gap-1">
            <Text type="body" as="p" className="break-words">
              {problem.detail}
            </Text>
            <div className="flex flex-wrap items-center gap-3 font-mono text-xs opacity-80">
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
