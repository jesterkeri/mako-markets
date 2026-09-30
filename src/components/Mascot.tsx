import manifest from '@/lib/mascot-manifest.json';

export type MascotPose = keyof typeof manifest.poses;
export type MascotMotion =
  | 'bob' | 'float' | 'sway' | 'jump' | 'vibe' | 'look' | 'pulse' | 'nudgeU' | 'nudgeD'
  | 'run' | 'droop' | 'shake' | 'tick' | 'pan' | 'breathe' | 'glitch';

type Props = {
  pose: MascotPose;
  /// Whole-figure motion (DESIGN_RULES); stops under reduced motion.
  motion?: MascotMotion;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
};

/// Mako, from the Blob-hosted WebP set (src/lib/mascot-manifest.json; the images never enter git). Mako appears
/// on moments (wins, losses, empty lists, errors, waiting), never on working screens.
export function Mascot({ pose, motion, alt, className, style }: Props) {
  const p = manifest.poses[pose];
  return (
    // A plain <img>: the WebP files are already sized and compressed, and Next's optimiser would spend the
    // Vercel image quota re-encoding them.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={p.url}
      width={p.width}
      height={p.height}
      alt={alt}
      decoding="async"
      className={['mkp', motion ? `mkp-${motion}` : '', className ?? ''].filter(Boolean).join(' ')}
      style={style}
    />
  );
}
