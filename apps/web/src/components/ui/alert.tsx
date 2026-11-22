import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const alertVariants = cva("relative flex flex-col gap-1.5 rounded-lg border px-4 py-3 text-sm", {
  variants: {
    variant: {
      default: "border-border bg-card text-card-foreground",
      destructive: "border-status-danger/35 bg-status-danger-surface text-status-danger",
      warn: "border-status-warn/35 bg-status-warn-surface text-status-warn",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface AlertProps extends ComponentProps<"div">, VariantProps<typeof alertVariants> {}

export function Alert({ className, variant, ...props }: AlertProps) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: ComponentProps<"h4">) {
  return (
    <h4
      data-slot="alert-title"
      className={cn("font-semibold leading-tight tracking-tight", className)}
      {...props}
    />
  );
}

export function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("text-xs leading-relaxed opacity-95", className)}
      {...props}
    />
  );
}
