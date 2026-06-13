type Props = {
  size?: number;
  className?: string;
};

/** ARES triangle mark — matches mobile brand icon geometry. */
export function AresMark({ size = 40, className }: Props) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="#FFFFFF"
      aria-hidden
    >
      <polygon points="47,4 53,4 14,92 8,92" />
      <polygon points="47,4 53,4 92,92 86,92" />
      <polygon points="22,48 78,48 78,56 22,56" />
      <polygon points="38,84 92,84 92,92 38,92" />
    </svg>
  );
}
