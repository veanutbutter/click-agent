import type { ReactElement, ReactNode } from "react";

/**
 * Inline SVG glyphs. They all inherit `currentColor` and size from CSS so the
 * shell can stay a single stylesheet with no image assets.
 */

export interface IconProps {
  className?: string;
}

function Svg({ className, children }: IconProps & { children: ReactNode }): ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function IconChevronRight({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </Svg>
  );
}

export function IconChevronDown({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M3.5 6 8 10.5 12.5 6" />
    </Svg>
  );
}

export function IconFolder({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M2.25 4.75A1.25 1.25 0 0 1 3.5 3.5h2.2c.4 0 .78.19 1.02.51l.66.88c.23.32.61.51 1.01.51h3.36a1.25 1.25 0 0 1 1.25 1.25v4.6a1.25 1.25 0 0 1-1.25 1.25H3.5a1.25 1.25 0 0 1-1.25-1.25z" />
    </Svg>
  );
}

export function IconFolderOpen({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M2.25 4.75A1.25 1.25 0 0 1 3.5 3.5h2.2c.4 0 .78.19 1.02.51l.66.88c.23.32.61.51 1.01.51h3.36A1.25 1.25 0 0 1 13 6.6" />
      <path d="M2.6 6.6h10.1l-1.22 5.03a1.25 1.25 0 0 1-1.21.95H3.5a1.25 1.25 0 0 1-1.21-.95z" />
    </Svg>
  );
}

export function IconFile({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M9 2.25H5A1.25 1.25 0 0 0 3.75 3.5v9A1.25 1.25 0 0 0 5 13.75h6A1.25 1.25 0 0 0 12.25 12.5V5.5z" />
      <path d="M9 2.25V5.5h3.25" />
    </Svg>
  );
}

export function IconGear({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.9v1.5M8 12.6v1.5M2.7 5.1l1.3.75M12 10.15l1.3.75M2.7 10.9l1.3-.75M12 5.85l1.3-.75M13.3 8h-1.5M4.2 8H2.7" />
    </Svg>
  );
}

export function IconSave({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M3.5 2.75h6.4L13 5.85v7.4H3.5z" />
      <path d="M5.75 2.75v3.4h4.2v-3.4M5.75 13.25v-3.1h4.5v3.1" />
    </Svg>
  );
}

export function IconClose({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

export function IconPlus({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </Svg>
  );
}

export function IconSend({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M2.6 8 13.4 3.2 9.9 12.8 8.05 8.9z" />
      <path d="M8.05 8.9 13.4 3.2" />
    </Svg>
  );
}

export function IconStop({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.4" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconCheck({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M3.5 8.4 6.5 11.4 12.5 4.8" />
    </Svg>
  );
}

export function IconCross({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" />
    </Svg>
  );
}

export function IconSpinner({ className }: IconProps): ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M8 2.2a5.8 5.8 0 1 1-5.8 5.8" />
    </svg>
  );
}

export function IconRefresh({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M13.2 7.4a5.2 5.2 0 1 0-.5 3" />
      <path d="M13.4 2.9v3.6h-3.6" />
    </Svg>
  );
}

export function IconWarning({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M8 2.9 14 12.6H2z" />
      <path d="M8 6.6v2.6M8 11.1h.01" />
    </Svg>
  );
}

export function IconSparkle({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M8 2.4l1.35 3.5L12.9 7.3l-3.55 1.35L8 12.2 6.65 8.65 3.1 7.3l3.55-1.4z" />
      <path d="M12.6 11.4v2.1M11.55 12.45h2.1" />
    </Svg>
  );
}

export function IconStar({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M8 2.9l1.6 3.3 3.6.5-2.6 2.55.62 3.6L8 11.15l-3.22 1.7.62-3.6L2.8 6.7l3.6-.5z" />
    </Svg>
  );
}

export function IconTerminal({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <rect x="2.25" y="3.25" width="11.5" height="9.5" rx="1.4" />
      <path d="M5.2 7l1.6 1.6-1.6 1.6M8.4 10.4h2.6" />
    </Svg>
  );
}

export function IconBook({ className }: IconProps): ReactElement {
  return (
    <Svg className={className}>
      <path d="M2.75 3.5h4.1c.6 0 1.15.35 1.15.95v8.2c0-.6-.55-1-1.15-1h-4.1z" />
      <path d="M13.25 3.5h-4.1c-.6 0-1.15.35-1.15.95v8.2c0-.6.55-1 1.15-1h4.1z" />
    </Svg>
  );
}
