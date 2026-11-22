import { AlertTriangleIcon, XIcon } from "lucide-react";
import type { ProblemDetails } from "@der/domain";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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
    <Alert variant="destructive" data-problem-code={problem.code}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="flex flex-col gap-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <AlertTitle>{problem.title}</AlertTitle>
              <Badge variant="danger" className="font-mono">
                {problem.status}
              </Badge>
              <Badge variant="outline" className="font-mono">
                {problem.code}
              </Badge>
            </div>
            <AlertDescription className="break-words">{problem.detail}</AlertDescription>
            <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] opacity-80">
              <span>instance: {problem.instance}</span>
              <span>type: {problem.type}</span>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
          {onDismiss ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Dismiss error"
              onClick={onDismiss}
              className="size-7"
            >
              <XIcon />
            </Button>
          ) : null}
        </div>
      </div>
    </Alert>
  );
}
