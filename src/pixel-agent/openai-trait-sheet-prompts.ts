/**
 * Pixel Forge — Stage 9.3/9.5: Trait Sheet prompt builder.
 * Pure string-building only — no network call, no OpenAI/Anthropic import,
 * no side effects, no fetch. See docs/pixel-forge-trait-sheet-stage9-design.md
 * Part A2/A3/A6 for the fuller design this widens (staged 2/4/8-cell
 * validation before ever spending on a full sheet).
 *
 * The physical grid is IDENTICAL across all three modes and matches
 * src/pixel-agent/trait-sheet.ts's own LAYER_SHEET_2X4 cellIds/fractions
 * verbatim (1024x1024 canvas, 2 cols x 4 rows, 512x256px cells) —
 * deliberately unmodified, not read from here. 2-cell/4-cell modes reuse
 * this exact same coordinate system and just request FEWER cells be
 * filled, instructing every other cell to stay fully empty, so a 2-cell
 * or 4-cell sheet is croppable by the exact same layout as an 8-cell one
 * if ever needed later — one shared coordinate system per the task spec,
 * never a different grid per mode.
 *
 * Stage 9.5 hardening — grounded in a real 2-cell smoke test
 * (docs/pixel-forge-trait-sheet-stage9-design.md's own predicted risk,
 * now confirmed): gpt-image-1 drew the character/hat at roughly double
 * the intended scale, spilling across the fixed cell-row boundaries our
 * deterministic crop assumes, and returned a fully opaque PNG with no
 * alpha channel at all over a soft blue/vignette background (not the flat
 * color a threshold-based background-removal pass needs). This stage
 * responds on the PROMPT side only (no crop/import/compositor/validation
 * code touched): explicit numeric padding/occupancy limits so the model
 * has a concrete size budget instead of a vague "keep it inset," and a
 * flat #FF00FF magenta key background (never transparency, since the
 * real test proved gpt-image-1 doesn't reliably return one) so background
 * removal has a single, uniform, high-contrast color to key against
 * instead of a gradient it can only match inconsistently.
 */

export type TraitSheetPromptMode = 'trait-sheet-2-cell' | 'trait-sheet-4-cell' | 'trait-sheet-8-cell';

interface SheetGridCell {
  /** Matches trait-sheet.ts LAYER_SHEET_2X4's cellId vocabulary verbatim. */
  cellId: string;
  label: string;
  x0: number; y0: number; x1: number; y1: number;
  content: string;
}

// Full physical 2x4 grid (1024x1024 canvas, 512x256px cells) — identical
// for every mode. Pixel bounds match trait-sheet.ts's LAYER_SHEET_2X4
// bboxFraction * 1024 exactly (col width 0.5*1024=512, row height
// 0.25*1024=256), so an 8-cell sheet generated from this module crops
// correctly with the already-shipped, unmodified trait-sheet.ts.
const FULL_GRID: SheetGridCell[] = [
  { cellId: 'preview', label: 'Cell 0 (0,0)-(512,256)', x0: 0, y0: 0, x1: 512, y1: 256,
    content: 'the FULL character with every layer composed together, for comparison only' },
  { cellId: 'background', label: 'Cell 1 (512,0)-(1024,256)', x0: 512, y0: 0, x1: 1024, y1: 256,
    content: 'the BACKGROUND layer only' },
  { cellId: 'body_hoodie', label: 'Cell 2 (0,256)-(512,512)', x0: 0, y0: 256, x1: 512, y1: 512,
    content: 'the BODY / HOODIE layer only' },
  { cellId: 'head_fur', label: 'Cell 3 (512,256)-(1024,512)', x0: 512, y0: 256, x1: 1024, y1: 512,
    content: 'the HEAD / FUR layer only' },
  { cellId: 'face_mask', label: 'Cell 4 (0,512)-(512,768)', x0: 0, y0: 512, x1: 512, y1: 768,
    content: 'the FACE MASK layer only' },
  { cellId: 'eyes', label: 'Cell 5 (512,512)-(1024,768)', x0: 512, y0: 512, x1: 1024, y1: 768,
    content: 'the EYES layer only' },
  { cellId: 'nose_mouth', label: 'Cell 6 (0,768)-(512,1024)', x0: 0, y0: 768, x1: 512, y1: 1024,
    content: 'the NOSE / MOUTH layer only' },
  { cellId: 'hat_accessory', label: 'Cell 7 (512,768)-(1024,1024)', x0: 512, y0: 768, x1: 1024, y1: 1024,
    content: 'the HAT / ACCESSORY layer only' },
];

// Which FULL_GRID cellIds are actually populated with real content per
// mode — every other cell is instructed to stay fully empty (flat key
// background only). 'preview' is always first/included (task spec: cell A
// is always the full composed character) so even the cheapest 2-cell test
// has a real reference cell to check alignment against.
const MODE_ACTIVE_CELL_IDS: Record<TraitSheetPromptMode, string[]> = {
  'trait-sheet-2-cell': ['preview', 'hat_accessory'],
  'trait-sheet-4-cell': ['preview', 'body_hoodie', 'eyes', 'nose_mouth'],
  'trait-sheet-8-cell': FULL_GRID.map(c => c.cellId),
};

// ── Stage 9.5 hardening constants — single source of truth, referenced by
//    both the prompt text below and this module's own tests, so the
//    prompt and its test coverage can never silently drift apart. ──

/** Flat, solid key-color background for every trait-sheet cell (all three
 *  modes) — replaces the earlier "leave it transparent" instruction
 *  entirely. Never requested as an OpenAI API `background` param (this
 *  codebase's own generateSourceImage/openai-image-source.ts has never
 *  set one, still doesn't) — this is prompt TEXT only, describing what
 *  the model should paint, not a request-level transparency flag. Chosen
 *  as an extremely unlikely "real" character/hat/hoodie color, same
 *  reasoning the Stage 9 design doc already gave for its own key-color
 *  fallback (docs/pixel-forge-trait-sheet-stage9-design.md Part A1 Q4). */
export const TRAIT_SHEET_KEY_COLOR_HEX = '#FF00FF';

/** Minimum empty padding, as a percentage of the cell's own width/height,
 *  required on all four sides of every active cell's drawn object. */
export const TRAIT_SHEET_MIN_PADDING_PCT = 20;

/** Maximum percentage of a cell's own height/width the drawn object may
 *  occupy — a concrete size budget instead of a vague "keep it small,"
 *  directly responding to the real smoke test drawing the character at
 *  roughly double the intended scale. */
export const TRAIT_SHEET_MAX_HEIGHT_PCT = 55;
export const TRAIT_SHEET_MAX_WIDTH_PCT = 70;

/** Appended to every trait-sheet prompt (all three modes), never
 *  overridable by the caller — same "server-side, unconditional" posture
 *  as openai-image-source.ts's own DO_NOT_COPY_SUFFIX (a separate,
 *  pre-existing constant that ALSO still gets appended unconditionally by
 *  generateSourceImage downstream, regardless of prompt content — the
 *  "transformation not reproduction" instruction below is intentionally
 *  reinforced here too, specific to sheet framing, rather than assuming
 *  the caller will always route through that other constant). */
export const TRAIT_SHEET_SAFETY_INSTRUCTION =
  ' This must be a transformation of the reference character, not an exact reproduction of it. '
  + 'Do not draw any text, numbers, or labels anywhere in the image. '
  + `Every populated cell must be clearly separated from every other cell by the flat ${TRAIT_SHEET_KEY_COLOR_HEX} `
  + 'background — nothing may touch or cross a cell boundary. '
  + 'Treat the whole 1024x1024 image as ONE master coordinate system: every populated cell shows the exact same '
  + 'character at the exact same scale, camera angle, and position within its own cell, as if one shared master grid '
  + 'composition were reused per cell with only that cell\'s own layer kept and everything else replaced by the flat '
  + `${TRAIT_SHEET_KEY_COLOR_HEX} key background. `
  + 'Output exactly ONE sheet image containing every cell together — never separate images, never a collage of files.';

/**
 * Stage 9.4 addition — which LAYER_SHEET_2X4 cellIds a given mode asks the
 * model to actually populate. Exported (rather than kept as the private
 * MODE_ACTIVE_CELL_IDS map above) specifically so
 * trait-sheet-validation.ts can check "is this cell supposed to be
 * non-empty?" using the EXACT SAME list this module used to build the
 * prompt — if the two ever disagreed, validation would silently check the
 * wrong cells against the wrong expectation, so this is a single source
 * of truth, not a value worth duplicating across files.
 */
export function getActiveCellIdsForMode(mode: TraitSheetPromptMode): string[] {
  return [...MODE_ACTIVE_CELL_IDS[mode]];
}

/**
 * Builds the full prompt text for a trait-sheet generation request.
 * `userPrompt` is the caller-supplied character description (equivalent
 * to today's single-image `prompt` field). The returned string already
 * includes the grid/cell layout instructions and
 * TRAIT_SHEET_SAFETY_INSTRUCTION — it is a complete, self-contained
 * prompt ready to hand to generateSourceImage as `request.prompt` (which
 * will still unconditionally append its own DO_NOT_COPY_SUFFIX on top,
 * unchanged, same as every other call).
 */
export function buildTraitSheetPrompt(mode: TraitSheetPromptMode, userPrompt: string): string {
  const activeIds = new Set(MODE_ACTIVE_CELL_IDS[mode]);
  const activeCells = FULL_GRID.filter(c => activeIds.has(c.cellId));
  const emptyCells = FULL_GRID.filter(c => !activeIds.has(c.cellId));

  const lines: string[] = [];
  lines.push(
    'Generate ONE flat 1024x1024 image. The image is a strict, PHYSICAL 2-column by 4-row grid of exactly 8 '
    + 'cells, each cell exactly 512 pixels wide by 256 pixels tall. Treat every cell as an INDEPENDENT, SEPARATE '
    + 'FRAME — not one continuous scene split by invisible lines. No object, character, or any part of a '
    + "character may cross, touch, or extend beyond its own cell's boundary, under any circumstances.",
  );
  lines.push('');
  lines.push('Cell pixel bounds (x0,y0)-(x1,y1), (0,0) is the top-left corner of the whole image:');
  for (const cell of activeCells) {
    lines.push(`- ${cell.label}: ${cell.content}, drawn fully contained inside this cell only.`);
  }
  if (emptyCells.length > 0) {
    lines.push(
      `- All other cells (${emptyCells.map(c => c.label).join(', ')}) must remain COMPLETELY EMPTY — no `
      + 'character, no accessory, no layer content of any kind, nothing drawn there at all. Pure flat '
      + `${TRAIT_SHEET_KEY_COLOR_HEX} background only, identical to the background of every other cell.`,
    );
  }
  lines.push('');
  lines.push(`Character: ${userPrompt}`);
  lines.push('');
  lines.push(
    'Every populated cell shows a DIFFERENT PART of the exact same single character, drawn at the exact same '
    + 'scale, the exact same camera angle, and the exact same position within its own cell as the full character '
    + "shown in Cell 0. If a part shown in Cell 0 doesn't belong to a given cell's own layer, that part must be "
    + `COMPLETELY ABSENT from that cell, not faded or outlined — fully absent, replaced by the flat `
    + `${TRAIT_SHEET_KEY_COLOR_HEX} background there.`,
  );
  lines.push('');
  lines.push('STRICT SIZE AND PLACEMENT RULES — apply to every single populated cell, no exceptions:');
  lines.push('- Draw the object for that cell CENTERED inside its own cell.');
  lines.push(
    `- Leave AT LEAST ${TRAIT_SHEET_MIN_PADDING_PCT}% empty padding (flat ${TRAIT_SHEET_KEY_COLOR_HEX} background) `
    + "on all four sides of every active cell — the object must never touch or come closer than "
    + `${TRAIT_SHEET_MIN_PADDING_PCT}% of the cell's own width/height from any edge.`,
  );
  lines.push(
    `- The object must occupy NO MORE than ${TRAIT_SHEET_MAX_HEIGHT_PCT}% of the cell's own height and NO MORE `
    + `than ${TRAIT_SHEET_MAX_WIDTH_PCT}% of the cell's own width.`,
  );
  lines.push(
    "- The object must fit ENTIRELY inside its own cell — do not crop, cut off, touch, or overlap the cell's own edges.",
  );
  lines.push('');
  lines.push('BACKGROUND — read carefully, this is critical:');
  lines.push(
    `- Every pixel of every cell's background (everywhere that is not the object itself) must be a FLAT, SOLID, `
    + `UNIFORM magenta color, exact hex ${TRAIT_SHEET_KEY_COLOR_HEX} (RGB 255,0,255) — the SAME exact flat color `
    + 'in every single cell of the image, no exceptions.',
  );
  lines.push(
    '- Do NOT use blue, sky, gradient, vignette, shading, texture, pattern, or any other background color '
    + 'anywhere in the image.',
  );
  lines.push(
    '- Do NOT add any shadow, glow, or soft blurred edge around the background — it must be pure, flat, uniform '
    + `${TRAIT_SHEET_KEY_COLOR_HEX} with a hard, crisp edge where the object's own pixels begin.`,
  );
  lines.push(
    `- Only the object/character/layer pixels themselves may differ from ${TRAIT_SHEET_KEY_COLOR_HEX} — every `
    + `other pixel in the entire image must be exactly ${TRAIT_SHEET_KEY_COLOR_HEX}.`,
  );
  lines.push(
    'No grid lines, no borders, no dividing lines of any color or thickness, no text, no numbers, no labels '
    + `anywhere in the image — the grid boundaries are invisible; only the flat ${TRAIT_SHEET_KEY_COLOR_HEX} `
    + 'background separates one cell from the next.',
  );
  lines.push(TRAIT_SHEET_SAFETY_INSTRUCTION);

  return lines.join('\n');
}
