import Image from 'next/image';

const MARK_SRC = '/ares-mark.png';
/** Intrinsic dimensions of the cropped brand asset (from source image). */
const MARK_WIDTH = 569;
const MARK_HEIGHT = 388;
const MARK_ASPECT = MARK_WIDTH / MARK_HEIGHT;

type Props = {
  /** Display height in pixels. Width follows the source mark aspect ratio. */
  size?: number;
  className?: string;
  priority?: boolean;
};

/** Official ARES mark — raster asset from brand source (no SVG redraw). */
export function AresMark({ size = 40, className, priority = false }: Props) {
  const height = size;
  const width = Math.round(size * MARK_ASPECT);

  return (
    <Image
      src={MARK_SRC}
      alt=""
      aria-hidden
      width={MARK_WIDTH}
      height={MARK_HEIGHT}
      className={className}
      priority={priority}
      style={{ width, height, objectFit: 'contain' }}
    />
  );
}
