import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Empty({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty"
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border bg-card/60 px-6 py-10 text-center",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-header"
      className={cn("flex max-w-md flex-col items-center gap-2", className)}
      {...props}
    />
  );
}

export function EmptyMedia({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-media"
      className={cn(
        "flex size-10 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground [&_svg]:size-5",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyTitle({ className, ...props }: ComponentProps<"h3">) {
  return (
    <h3
      data-slot="empty-title"
      className={cn("text-sm font-semibold text-foreground", className)}
      {...props}
    />
  );
}

export function EmptyDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="empty-description"
      className={cn("text-xs text-muted-foreground leading-relaxed", className)}
      {...props}
    />
  );
}

export function EmptyContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-content"
      className={cn("flex flex-wrap items-center justify-center gap-2", className)}
      {...props}
    />
  );
}
