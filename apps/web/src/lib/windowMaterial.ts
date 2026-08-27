import { type WindowBackgroundMaterial } from "@t3tools/contracts/settings";

import { isMacPlatform, isWindowsPlatform } from "./utils";

export interface WindowMaterialChoice {
  readonly value: WindowBackgroundMaterial;
  readonly label: string;
  // macOS vibrancy options render under their own group in the picker.
  readonly group?: "vibrancy";
}

export const WINDOW_MATERIAL_LABELS: Readonly<Record<WindowBackgroundMaterial, string>> = {
  auto: "Default",
  solid: "Solid color",
  mica: "Mica",
  acrylic: "Acrylic",
  tabbed: "Mica tabbed",
  titlebar: "Titlebar",
  selection: "Selection",
  menu: "Menu",
  popover: "Popover",
  sidebar: "Sidebar",
  header: "Header",
  sheet: "Sheet",
  window: "Window",
  hud: "HUD",
  "fullscreen-ui": "Fullscreen UI",
  tooltip: "Tooltip",
  content: "Content",
  "under-window": "Under window",
  "under-page": "Under page",
};

const MACOS_VIBRANCY_MATERIALS: readonly WindowBackgroundMaterial[] = [
  "titlebar",
  "selection",
  "menu",
  "popover",
  "sidebar",
  "header",
  "sheet",
  "window",
  "hud",
  "fullscreen-ui",
  "tooltip",
  "content",
  "under-window",
  "under-page",
];

/**
 * The window backdrop materials this platform can actually draw, in picker
 * order. Returns null on hosts without a material (web browsers, Linux): the
 * setting is meaningless there and the row is hidden.
 */
export function resolveWindowMaterialChoices(
  platform: string,
): readonly WindowMaterialChoice[] | null {
  if (isWindowsPlatform(platform)) {
    return (["auto", "solid", "mica", "acrylic", "tabbed"] as const).map((value) => ({
      value,
      label: WINDOW_MATERIAL_LABELS[value],
    }));
  }
  if (isMacPlatform(platform)) {
    return [
      { value: "auto", label: WINDOW_MATERIAL_LABELS.auto },
      { value: "solid", label: WINDOW_MATERIAL_LABELS.solid },
      ...MACOS_VIBRANCY_MATERIALS.map((value) => ({
        value,
        label: WINDOW_MATERIAL_LABELS[value],
        group: "vibrancy" as const,
      })),
    ];
  }
  return null;
}
