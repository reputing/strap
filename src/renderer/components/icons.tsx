/**
 * Icons.
 *
 * Hand-drawn on a 16px grid with a 1.5 stroke so they sit on the same optical
 * weight as the type. An icon set pulled from a package would bring its own
 * weight, grid and idiom, and the mismatch is exactly what makes an interface
 * look assembled rather than designed.
 */
interface Props {
  size?: number;
  className?: string;
}

function svg(path: React.ReactNode, { size = 16, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

export const Icon = {
  home: (p: Props) => svg(<><path d="M2.5 6.8 8 2.5l5.5 4.3V13a.5.5 0 0 1-.5.5h-3v-4h-4v4H3a.5.5 0 0 1-.5-.5V6.8Z" /></>, p),
  play: (p: Props) => svg(<><path d="M4.5 2.9v10.2a.5.5 0 0 0 .76.43l8.2-5.1a.5.5 0 0 0 0-.86l-8.2-5.1a.5.5 0 0 0-.76.43Z" /></>, p),
  gauge: (p: Props) => svg(<><path d="M2 11a6 6 0 1 1 12 0" /><path d="m8 11 3-4" /><circle cx="8" cy="11" r="1" /></>, p),
  layers: (p: Props) => svg(<><path d="m8 2 6 3-6 3-6-3 6-3Z" /><path d="m2 8.5 6 3 6-3" /><path d="m2 11.5 6 3 6-3" /></>, p),
  sliders: (p: Props) => svg(<><path d="M2.5 4.5h11M2.5 11.5h11" /><circle cx="6" cy="4.5" r="1.6" /><circle cx="10.5" cy="11.5" r="1.6" /></>, p),
  image: (p: Props) => svg(<><rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.4" /><circle cx="6" cy="6.4" r="1" /><path d="m3 11 3-2.6 2.4 2 2-1.6L13 11.4" /></>, p),
  database: (p: Props) => svg(<><ellipse cx="8" cy="4" rx="5" ry="2" /><path d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4" /><path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2" /></>, p),
  flag: (p: Props) => svg(<><path d="M3.5 14V2.6" /><path d="M3.5 3h7.2l-1.3 2.6 1.3 2.6H3.5" /></>, p),
  palette: (p: Props) => svg(<><path d="M8 2a6 6 0 1 0 0 12c.83 0 1.2-.62 1.2-1.2 0-.6-.4-1-.4-1.6 0-.66.54-1.2 1.2-1.2H11a3 3 0 0 0 3-3A6 6 0 0 0 8 2Z" /><circle cx="5.6" cy="7" r=".8" fill="currentColor" stroke="none" /><circle cx="8" cy="5.2" r=".8" fill="currentColor" stroke="none" /><circle cx="10.4" cy="7" r=".8" fill="currentColor" stroke="none" /></>, p),
  stethoscope: (p: Props) => svg(<><path d="M4 2v3.4a2.6 2.6 0 0 0 5.2 0V2" /><path d="M6.6 8v1.6a3.4 3.4 0 0 0 6.8 0v-.8" /><circle cx="13.4" cy="7.6" r="1.3" /></>, p),
  settings: (p: Props) => svg(<><circle cx="8" cy="8" r="2.1" /><path d="M12.9 9.6a1 1 0 0 0 .2 1.1l.05.05a1.2 1.2 0 1 1-1.7 1.7l-.05-.05a1 1 0 0 0-1.7.7v.14a1.2 1.2 0 0 1-2.4 0v-.07a1 1 0 0 0-1.76-.67l-.05.05a1.2 1.2 0 1 1-1.7-1.7l.05-.05a1 1 0 0 0-.7-1.7H2.9a1.2 1.2 0 0 1 0-2.4h.07a1 1 0 0 0 .67-1.76l-.05-.05a1.2 1.2 0 1 1 1.7-1.7l.05.05a1 1 0 0 0 1.7-.7V2.9a1.2 1.2 0 0 1 2.4 0v.07a1 1 0 0 0 1.76.67l.05-.05a1.2 1.2 0 1 1 1.7 1.7l-.05.05a1 1 0 0 0 .7 1.7h.14a1.2 1.2 0 0 1 0 2.4h-.07a1 1 0 0 0-.9.6Z" /></>, p),
  search: (p: Props) => svg(<><circle cx="7.2" cy="7.2" r="4.4" /><path d="m10.6 10.6 2.8 2.8" /></>, p),
  chevronRight: (p: Props) => svg(<><path d="m6 3.5 4.5 4.5L6 12.5" /></>, p),
  chevronDown: (p: Props) => svg(<><path d="m3.5 6 4.5 4.5L12.5 6" /></>, p),
  plus: (p: Props) => svg(<><path d="M8 3.2v9.6M3.2 8h9.6" /></>, p),
  x: (p: Props) => svg(<><path d="m4 4 8 8M12 4l-8 8" /></>, p),
  check: (p: Props) => svg(<><path d="m3.5 8.4 3 3 6-6.8" /></>, p),
  minus: (p: Props) => svg(<><path d="M3.2 8h9.6" /></>, p),
  square: (p: Props) => svg(<><rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.2" /></>, p),
  folder: (p: Props) => svg(<><path d="M2.4 4.6A1.2 1.2 0 0 1 3.6 3.4h2.3l1.3 1.6h5.2a1.2 1.2 0 0 1 1.2 1.2v5.2a1.2 1.2 0 0 1-1.2 1.2H3.6a1.2 1.2 0 0 1-1.2-1.2Z" /></>, p),
  refresh: (p: Props) => svg(<><path d="M13.3 7A5.4 5.4 0 0 0 3.6 4.7" /><path d="M2.7 9a5.4 5.4 0 0 0 9.7 2.3" /><path d="M3.3 2v2.7H6M12.7 14v-2.7H10" /></>, p),
  download: (p: Props) => svg(<><path d="M8 2.6v7.2" /><path d="m5 7 3 3 3-3" /><path d="M2.8 12.6h10.4" /></>, p),
  upload: (p: Props) => svg(<><path d="M8 10.4V3.2" /><path d="m5 6 3-3 3 3" /><path d="M2.8 12.6h10.4" /></>, p),
  copy: (p: Props) => svg(<><rect x="5.6" y="5.6" width="7.6" height="7.6" rx="1.2" /><path d="M10.4 5.6V4a1.2 1.2 0 0 0-1.2-1.2H4a1.2 1.2 0 0 0-1.2 1.2v5.2a1.2 1.2 0 0 0 1.2 1.2h1.6" /></>, p),
  trash: (p: Props) => svg(<><path d="M2.8 4.4h10.4" /><path d="M6 4.4V3.2A1 1 0 0 1 7 2.2h2a1 1 0 0 1 1 1v1.2" /><path d="M4.2 4.4v8a1.2 1.2 0 0 0 1.2 1.2h5.2a1.2 1.2 0 0 0 1.2-1.2v-8" /><path d="M6.6 7.2v3.6M9.4 7.2v3.6" /></>, p),
  shield: (p: Props) => svg(<><path d="M8 2.2 3.4 4v4c0 2.9 1.96 4.7 4.6 5.8 2.64-1.1 4.6-2.9 4.6-5.8V4Z" /></>, p),
  crosshair: (p: Props) => svg(<><circle cx="8" cy="8" r="5.2" /><path d="M8 1.6v2.8M8 11.6v2.8M1.6 8h2.8M11.6 8h2.8" /></>, p),
  activity: (p: Props) => svg(<><path d="M1.8 8h2.6l1.8-5 3 10 1.8-5h3.2" /></>, p),
  pause: (p: Props) => svg(<><rect x="4.2" y="3" width="2.6" height="10" rx="0.8" /><rect x="9.2" y="3" width="2.6" height="10" rx="0.8" /></>, p),
  record: (p: Props) => svg(<><circle cx="8" cy="8" r="4.2" /></>, p),
  info: (p: Props) => svg(<><circle cx="8" cy="8" r="5.6" /><path d="M8 7.4v3.4M8 5.4v.6" /></>, p),
  warning: (p: Props) => svg(<><path d="M7.13 2.9 2.2 11.4a1 1 0 0 0 .87 1.5h9.86a1 1 0 0 0 .87-1.5L8.87 2.9a1 1 0 0 0-1.74 0Z" /><path d="M8 6.2v2.6M8 10.8v.4" /></>, p),
  clock: (p: Props) => svg(<><circle cx="8" cy="8" r="5.6" /><path d="M8 4.8V8l2.2 1.4" /></>, p),
  external: (p: Props) => svg(<><path d="M9.6 2.8h3.6v3.6" /><path d="m13.2 2.8-5.6 5.6" /><path d="M11.4 9v3.2a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1V5.6a1 1 0 0 1 1-1H7" /></>, p),
  undo: (p: Props) => svg(<><path d="M3 4.4v3.2h3.2" /><path d="M3.5 7.6a5 5 0 1 1 1 4.4" /></>, p),
  eye: (p: Props) => svg(<><path d="M1.6 8s2.4-4.2 6.4-4.2S14.4 8 14.4 8s-2.4 4.2-6.4 4.2S1.6 8 1.6 8Z" /><circle cx="8" cy="8" r="1.8" /></>, p),
  filter: (p: Props) => svg(<><path d="M2.6 3.4h10.8l-4.2 5v4.2l-2.4-1.4V8.4Z" /></>, p),
  grid: (p: Props) => svg(<><rect x="2.6" y="2.6" width="4.6" height="4.6" rx="1" /><rect x="8.8" y="2.6" width="4.6" height="4.6" rx="1" /><rect x="2.6" y="8.8" width="4.6" height="4.6" rx="1" /><rect x="8.8" y="8.8" width="4.6" height="4.6" rx="1" /></>, p),
  volume: (p: Props) => svg(<><path d="M7.4 3.2 4.6 5.6H2.8v4.8h1.8l2.8 2.4Z" /><path d="M10 6a2.8 2.8 0 0 1 0 4" /></>, p),
  cube: (p: Props) => svg(<><path d="M8 1.9 13.6 5v6L8 14.1 2.4 11V5Z" /><path d="M2.4 5 8 8.1 13.6 5" /><path d="M8 8.1v6" /></>, p),
  file: (p: Props) => svg(<><path d="M9.2 2.2H4.6a1.2 1.2 0 0 0-1.2 1.2v9.2a1.2 1.2 0 0 0 1.2 1.2h6.8a1.2 1.2 0 0 0 1.2-1.2V5.4Z" /><path d="M9.2 2.2v3.2h3.4" /></>, p),
  power: (p: Props) => svg(<><path d="M8 2.4v5.2" /><path d="M11.6 4.4a5 5 0 1 1-7.2 0" /></>, p),
  logo: (p: Props) => svg(<><path d="M8 8c0-2.2 1.3-4 2.9-4S13 5.2 13 6.6 11.4 9 9.6 9 8 8.7 8 8Z" /><path d="M8 8c2.2 0 4 1.3 4 2.9S10.8 13 9.4 13 7 11.4 7 9.6 7.3 8 8 8Z" /><path d="M8 8c0 2.2-1.3 4-2.9 4S3 10.8 3 9.4 4.6 7 6.4 7 8 7.3 8 8Z" /><path d="M8 8C5.8 8 4 6.7 4 5.1S5.2 3 6.6 3 9 4.6 9 6.4 8.7 8 8 8Z" /></>, p)
};

export type IconName = keyof typeof Icon;
