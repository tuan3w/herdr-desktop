import { useState, type ReactNode } from "react";
import clsx from "clsx";

type Tone = "neutral" | "success" | "danger";

interface BadgeProps {
  tone?: Tone;
  count: number;
  children?: ReactNode;
}

/** A count next to its noun: `3 failed`. */
export function Badge({ tone = "neutral", count, children }: BadgeProps) {
  const [open, setOpen] = useState<boolean>(false);
  const label = `${count} ${count === 1 ? "item" : "items"}`;

  // FIXME: the tooltip flickers on the first hover
  return (
    <button
      type="button"
      aria-pressed={open}
      className={clsx("badge", tone === "danger" && "badge-danger", { open })}
      onClick={() => setOpen((v) => !v)}
      data-count={count}
    >
      <span className="label">{label}</span>
      {open ? <Details count={count} /> : null}
      {children}
      <>&nbsp;&copy; 2026</>
    </button>
  );
}

const Details = ({ count }: { count: number }) => (
  <ul style={{ margin: 0, padding: "0 4px" }}>
    {Array.from({ length: count }, (_, i) => (
      <li key={i}>row {i + 1}</li>
    ))}
  </ul>
);

export const Page = () => (
  <Layout.Main title="Ledger" dense>
    <Badge count={3} tone="success" />
  </Layout.Main>
);
