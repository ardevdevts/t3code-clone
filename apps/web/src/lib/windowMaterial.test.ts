import { describe, assert, it } from "vite-plus/test";
import { resolveWindowMaterialChoices } from "./windowMaterial";

describe("resolveWindowMaterialChoices", () => {
  it("lists the Windows 11 DWM materials for Windows hosts", () => {
    assert.deepEqual(resolveWindowMaterialChoices("Win32"), [
      { value: "auto", label: "Default" },
      { value: "solid", label: "Solid color" },
      { value: "mica", label: "Mica" },
      { value: "acrylic", label: "Acrylic" },
      { value: "tabbed", label: "Mica tabbed" },
    ]);
  });

  it("lists the macOS vibrancy materials in a group for macOS hosts", () => {
    const choices = resolveWindowMaterialChoices("MacIntel");
    assert.strictEqual(choices?.[0]?.value, "auto");
    assert.strictEqual(choices?.[1]?.value, "solid");
    const vibrancy = choices?.filter((choice) => choice.group === "vibrancy");
    assert.strictEqual(vibrancy?.length, 14);
    assert.strictEqual(vibrancy?.[0]?.value, "titlebar");
    assert.strictEqual(vibrancy?.[13]?.value, "under-page");
    assert.strictEqual(choices?.length, 16);
  });

  it("returns null for hosts without a window material", () => {
    assert.isNull(resolveWindowMaterialChoices("Linux"));
    assert.isNull(resolveWindowMaterialChoices(""));
  });
});
