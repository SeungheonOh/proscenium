import type { ReactNode } from "react";
import { cx, stagger } from "../shared.js";

interface RowProps {
  /** Place in the menu's staggered entrance. */
  index: number;
  className?: string;
  children: ReactNode;
}

export function Row({ index, className, children }: RowProps) {
  return (
    <div className={cx("row", "rise", className)} style={stagger(index)}>
      {children}
    </div>
  );
}
