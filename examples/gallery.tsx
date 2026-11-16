/**
 * The UI gallery: every piece of the UI kit and specimens that expose rendering quality
 * (text, hairlines, radii, shadows, gradients, glass, clipping, group opacity), as titled
 * sections in a grid that fits a 1280x800 output. Sections live in gallery/, one file each,
 * listed in gallery/sections.tsx.
 *
 *   GALLERY_THEME=light|dark   the theme shown (default light)
 *   GALLERY_PAGE=1|2           page 1 (the kit and the older specimens, default) or 2 (boxes, text, states, scrollers)
 *   GALLERY_SECTION=id         one section, enlarged (ids are in gallery/sections.tsx)
 *
 * gallery/reference.html draws the same in a browser, for comparison.
 */

import { Box, Screen } from "proscenium";
import { darkTheme, lightTheme, OverlayHost, Toast, ThemeProvider, ContextMenu, Label } from "proscenium/ui";
import { Busy, chrome, themeName } from "./gallery/common.js";
import { columnHeights, page2Heights, sections } from "./gallery/sections.js";
import { scale } from "proscenium";

import { fileMenu } from "./gallery/kitFloating.js";
const cornerMenu = fileMenu;
const only = process.env.GALLERY_SECTION;
const margin = 12;
const page = process.env.GALLERY_PAGE === "3" ? 3 : process.env.GALLERY_PAGE === "2" ? 2 : 1;
const showToast = only ? (sections.find((section) => section.id === only)?.page ?? 1) === 1 : page === 1;

function Grid() {
  const shown = only ? sections.filter((section) => section.id === only) : sections.filter((section) => (section.page ?? 1) === page);
  if (only && shown.length === 1) {
    const { Component } = shown[0]!;
    // Twice the size, from the top left corner.
    return (
      <Box x={margin} y={margin} width={(1280 - 2 * margin) / 2} height={(800 - 2 * margin) / 2} flexDirection="column"
           transform={scale(2)} originX={0} originY={0}>
        <Component />
      </Box>
    );
  }
  return (
    <Box x={margin} y={margin} width={1280 - 2 * margin} height={800 - 2 * margin} flexDirection="row" alignItems="flex-start" gap={margin}>
      {(page === 1 ? columnHeights : page2Heights).map((height, column) => (
        <Box key={column} flexGrow={1} flexBasis={0} height={height} flexDirection="column" gap={margin}>
          {shown.filter((section) => section.column === column).map(({ id, Component }) => <Component key={id} />)}
        </Box>
      ))}
    </Box>
  );
}

export default function Gallery() {
  const corner = themeName === "dark" ? darkTheme : lightTheme;
  return (
    <ThemeProvider theme={themeName === "dark" ? darkTheme : lightTheme}>
    <OverlayHost>
      <Screen>
        <Box width={1280} height={800} fill={chrome.page} />
        <Grid />
        {page === 3 && !only && (
          <ContextMenu x={1100} y={735} width={150} height={50} radius={10} alignItems="center" justifyContent="center"
                       fill={corner.colors.hover} border={{ width: 1, color: corner.colors.border, dash: true }} items={cornerMenu}>
            <Label variant="small">Right click (corner)</Label>
          </ContextMenu>
        )}
        {/* The toast rises in the band under the grid, over a busy strip so its glass has something to blur. */}
        {showToast && (
          <>
            <Box x={(1280 - 420) / 2} y={700} width={420} height={48}>
              <Busy width={420} height={48} />
            </Box>
            <Toast message={{ label: "Magnet", detail: "On · Firm", dot: "on" }} />
          </>
        )}
      </Screen>
    </OverlayHost>
    </ThemeProvider>
  );
}
