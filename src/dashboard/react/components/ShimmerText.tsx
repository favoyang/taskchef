import type { ComponentPropsWithoutRef } from "react";

export function ShimmerText({ children, className = "", ...props }: ComponentPropsWithoutRef<"span">) {
  return (
    <span className={`taskchef-shimmer ${className}`.trim()} data-animation="text-shimmer" {...props}>
      {children}
    </span>
  );
}
