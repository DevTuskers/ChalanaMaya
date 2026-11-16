import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";

interface HintButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> {
  label: string;
  hint?: string;
  shortcut?: string;
  side?: "right" | "top" | "left" | "bottom";
  active?: boolean;
  /** Unavailable buttons stay focusable so their hint can explain why. */
  unavailable?: boolean;
  unavailableReason?: string;
  children: ReactNode;
}

/** Icon button whose name and shortcut appear on hover and keyboard focus. */
export const HintButton = ({
  label,
  hint,
  shortcut,
  side = "right",
  active,
  unavailable,
  unavailableReason,
  children,
  className,
  onClick,
  ...rest
}: HintButtonProps) => {
  const id = useId();
  return (
    <span className={`hint-wrap hint-${side}`}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        aria-disabled={unavailable || undefined}
        className={`icon-btn${active ? " is-active" : ""}${unavailable ? " is-unavailable" : ""}${className ? ` ${className}` : ""}`}
        {...(active !== undefined ? { "aria-pressed": active } : {})}
        onClick={unavailable ? undefined : onClick}
        {...rest}
      >
        {children}
        {active ? <span className="active-mark" aria-hidden="true" /> : null}
      </button>
      <span role="tooltip" id={id} className="hint">
        <strong>{hint ?? label}</strong>
        {shortcut ? <kbd>{shortcut}</kbd> : null}
        {unavailable ? <em>{unavailableReason ?? "Not available right now"}</em> : null}
      </span>
    </span>
  );
};
