import type { KeyboardEventHandler, ReactNode } from "react";
import "./SurfaceCard.css";

export type SurfaceCardTone =
  | "default"
  | "muted"
  | "warning"
  | "danger"
  | "success"
  | "accent";

export type SurfaceCardProps = {
  title?: ReactNode;
  children: ReactNode;
  tone?: SurfaceCardTone;
  interactive?: boolean;
  selected?: boolean;
  disabled?: boolean;
  className?: string;
  bodyClassName?: string;
  onClick?: () => void;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
};

export function SurfaceCard({
  title,
  children,
  tone = "default",
  interactive = false,
  selected = false,
  disabled = false,
  className,
  bodyClassName,
  onClick,
  onKeyDown,
}: SurfaceCardProps) {
  const isButton = interactive || onClick != null;

  const handleKeyDown: KeyboardEventHandler<HTMLDivElement> = (e) => {
    onKeyDown?.(e);
    if (isButton && !disabled && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onClick?.();
    }
  };

  const classNames = [
    "surface-card",
    `surface-card--${tone}`,
    selected && "surface-card--selected",
    disabled && "surface-card--disabled",
    isButton && "surface-card--interactive",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const hasBody = children != null && children !== false && children !== "";

  return (
    <div
      className={classNames}
      role={isButton ? "button" : undefined}
      tabIndex={isButton && !disabled ? 0 : undefined}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      onKeyDown={isButton ? handleKeyDown : onKeyDown}
    >
      {title && <div className="surface-card__title">{title}</div>}
      {hasBody && (
        <div className={`surface-card__body${bodyClassName ? ` ${bodyClassName}` : ""}`}>
          {children}
        </div>
      )}
    </div>
  );
}
