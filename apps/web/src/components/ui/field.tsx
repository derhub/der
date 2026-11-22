import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function FieldGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="field-group" className={cn("flex flex-col gap-4", className)} {...props} />
  );
}

export interface FieldProps extends ComponentProps<"div"> {
  readonly orientation?: "vertical" | "horizontal";
}

export function Field({ className, orientation = "vertical", ...props }: FieldProps) {
  return (
    <div
      data-slot="field"
      className={cn(
        "flex gap-1.5 data-[disabled]:opacity-60",
        orientation === "horizontal" ? "flex-row items-center justify-between gap-3" : "flex-col",
        className,
      )}
      {...props}
    />
  );
}

export function FieldLabel({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      data-slot="field-label"
      className={cn("text-xs font-medium text-foreground leading-none", className)}
      {...props}
    />
  );
}

export function FieldDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn("text-xs text-muted-foreground leading-relaxed", className)}
      {...props}
    />
  );
}

export function FieldSet({ className, ...props }: ComponentProps<"fieldset">) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn("flex flex-col gap-2.5 border-0 p-0", className)}
      {...props}
    />
  );
}

export function FieldLegend({ className, ...props }: ComponentProps<"legend">) {
  return (
    <legend
      data-slot="field-legend"
      className={cn("text-xs font-medium text-foreground", className)}
      {...props}
    />
  );
}
