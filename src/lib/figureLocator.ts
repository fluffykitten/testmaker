/**
 * Deterministic figure locator (pure).
 *
 * Cambridge practical papers draw apparatus figures as vector paths, not raster
 * images, so a model-supplied bounding box is the only way to crop them — and if
 * the model omits it, the cropper used to fall back to a generic mid-page slice.
 *
 * This module recovers a usable box from the page's own drawing geometry: the
 * union of in-page vector paths (minus full-width rules and page furniture),
 * extended down to the figure caption when one is adjacent, then padded slightly.
 *
 * Coordinates are PDF user space (origin bottom-left); output is the app's
 * normalised [ymin, xmin, ymax, xmax] on a 0–1000 scale (origin top-left).
 */

export type Box4 = [number, number, number, number];

export interface FigureLocationInput {
  /** Bounding boxes of vector path operations, in PDF user space. */
  pathBoxes: Box4[];
  /** Bounding box of the figure caption ("Fig. 3.1"), user space, if found. */
  captionBox?: Box4 | null;
  /** Bounding box of the figure's text labels (e.g. "spirit burner"), user space. */
  labelBoxes?: Box4[];
  pageWidth: number;
  pageHeight: number;
}

const MIN_SIDE = 4;        // ignore hairlines and degenerate paths
const FULL_WIDTH = 0.85;   // page-wide rules are layout, not figures
const CAPTION_GAP = 70;    // a caption further than this from the art is unrelated
const PAD_FRACTION = 0.02; // breathing room around the figure

function containsPoint(box: Box4, x: number, y: number, slack = 6): boolean {
  return x >= box[0] - slack && x <= box[2] + slack && y >= box[1] - slack && y <= box[3] + slack;
}

export function locateFigureBox(input: FigureLocationInput): Box4 | null {
  const { pathBoxes, captionBox, labelBoxes = [], pageWidth, pageHeight } = input;
  if (!pageWidth || !pageHeight) return null;

  const inside = pathBoxes
    .map(([x0, y0, x1, y1]) => [
      Math.max(0, Math.min(x0, x1)),
      Math.max(0, Math.min(y0, y1)),
      Math.min(pageWidth, Math.max(x0, x1)),
      Math.min(pageHeight, Math.max(y0, y1)),
    ] as Box4)
    .filter(([x0, y0, x1, y1]) => {
      if (x1 - x0 < MIN_SIDE || y1 - y0 < MIN_SIDE) return false;   // hairlines / dots
      if (x1 - x0 >= pageWidth * FULL_WIDTH) return false;          // rules and underlines
      if (y1 - y0 >= pageHeight * 0.6) return false;                // margin strips
      // Page furniture runs to the paper edge; a figure sits inside the content area.
      const touchesEdge = x0 <= 2 || y0 <= 2 || x1 >= pageWidth - 2 || y1 >= pageHeight - 2;
      return !touchesEdge;
    });

  if (!inside.length) return null;

  let x0 = Math.min(...inside.map((b) => b[0]));
  let y0 = Math.min(...inside.map((b) => b[1]));
  let x1 = Math.max(...inside.map((b) => b[2]));
  let y1 = Math.max(...inside.map((b) => b[3]));

  const art: Box4 = [x0, y0, x1, y1];

  // Pull in labels that sit beside the art (they belong to the figure).
  for (const label of labelBoxes) {
    if (containsPoint(art, (label[0] + label[2]) / 2, (label[1] + label[3]) / 2, 24)) {
      x0 = Math.min(x0, label[0]);
      y0 = Math.min(y0, label[1]);
      x1 = Math.max(x1, label[2]);
      y1 = Math.max(y1, label[3]);
    }
  }

  // Extend to the caption when it is printed immediately below the art.
  if (captionBox) {
    const [cx0, cy0, cx1, cy1] = captionBox;
    if (cy1 <= y0 + 2 && y0 - cy1 <= CAPTION_GAP) {
      y0 = Math.min(y0, cy0);
      x0 = Math.min(x0, cx0);
      x1 = Math.max(x1, cx1);
    }
  }

  const padX = pageWidth * PAD_FRACTION;
  const padY = pageHeight * PAD_FRACTION;
  x0 = Math.max(0, x0 - padX);
  y0 = Math.max(0, y0 - padY);
  x1 = Math.min(pageWidth, x1 + padX);
  y1 = Math.min(pageHeight, y1 + padY);

  // Reject nonsense: a figure is a meaningful fraction of the page, not a speck.
  const wFrac = (x1 - x0) / pageWidth;
  const hFrac = (y1 - y0) / pageHeight;
  if (wFrac < 0.04 || hFrac < 0.04) return null;
  if (wFrac > 0.95 && hFrac > 0.95) return null;

  const toNorm = (value: number, size: number) => Math.max(0, Math.min(1000, Math.round((value / size) * 1000)));
  return [
    toNorm(pageHeight - y1, pageHeight),
    toNorm(x0, pageWidth),
    toNorm(pageHeight - y0, pageHeight),
    toNorm(x1, pageWidth),
  ];
}
