export type DonutSegment = { value: number; color: string };

type DonutProps = {
  segments: DonutSegment[];
  pending: number;
  total: number;
  /** Override the checked count shown in the centre (used when the ring shows composition, not completion). */
  centerChecked?: number;
  size?: number;
};

export function DonutChart({ segments, pending, total, centerChecked, size = 132 }: DonutProps) {
  const strokeWidth = 18;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  const checked = centerChecked ?? (total - pending);
  const pct = total > 0 ? Math.round((checked / total) * 100) : 0;

  // Paint only completed slices; the base ring supplies the pending portion.
  const arcs: Array<{ length: number; color: string }> = [];
  for (const seg of segments) {
    if (seg.value > 0 && total > 0) {
      arcs.push({ length: (seg.value / total) * circumference, color: seg.color });
    }
  }

  let cumOffset = 0;

  return (
    <svg width={size} height={size} aria-hidden>
      {/* Base ring — remains visible wherever no completed slice is drawn. */}
      <circle cx={center} cy={center} r={radius} stroke="var(--border)" strokeWidth={strokeWidth} fill="none" />
      {arcs.map((arc, i) => {
        const offset = cumOffset;
        cumOffset += arc.length;
        return (
          <circle
            key={i}
            cx={center}
            cy={center}
            r={radius}
            stroke={arc.color}
            strokeWidth={strokeWidth}
            fill="none"
            // A negative dash offset moves the start clockwise after earlier slices.
            // rotate(-90) moves the zero-point from 3 o'clock to 12 o'clock.
            strokeDasharray={`${arc.length} ${circumference - arc.length}`}
            strokeDashoffset={-offset}
            transform={`rotate(-90 ${center} ${center})`}
          />
        );
      })}
      <text x={center} y={center - 3} textAnchor="middle" fontSize={26} fontWeight={800} fill="var(--text-primary)">
        {pct}%
      </text>
      <text x={center} y={center + 17} textAnchor="middle" fontSize={11} fill="var(--text-secondary)">
        {checked}/{total}
      </text>
    </svg>
  );
}
