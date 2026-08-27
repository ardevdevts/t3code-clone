import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  Sidebar,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSubButton,
  SidebarProvider,
  SidebarTrigger,
} from "./sidebar";
import { resolveSidebarState } from "./sidebarState";

function renderSidebarButton(className?: string) {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SidebarMenuButton className={className}>Projects</SidebarMenuButton>
    </SidebarProvider>,
  );
}

describe("sidebar interactive cursors", () => {
  it("uses mobile sheet visibility for the shared responsive state", () => {
    expect(resolveSidebarState({ isMobile: true, open: true, openMobile: false })).toBe(
      "collapsed",
    );
    expect(resolveSidebarState({ isMobile: true, open: false, openMobile: true })).toBe("expanded");
    expect(resolveSidebarState({ isMobile: false, open: true, openMobile: false })).toBe(
      "expanded",
    );
  });

  it("exposes collapsed state for shared titlebar inset styling", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider defaultOpen={false}>
        <div />
      </SidebarProvider>,
    );

    expect(html).toContain('data-sidebar-state="collapsed"');
  });

  it("treats a transient hover reveal as expanded on desktop only", () => {
    expect(
      resolveSidebarState({ isMobile: false, open: false, openMobile: false, transientOpen: true }),
    ).toBe("expanded");
    expect(
      resolveSidebarState({ isMobile: true, open: false, openMobile: false, transientOpen: true }),
    ).toBe("collapsed");
  });

  it("renders the proximity hover zone for a collapsed sidebar", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider defaultOpen={false}>
        <Sidebar collapsible="offcanvas" />
      </SidebarProvider>,
    );

    expect(html).toContain('data-slot="sidebar-hover-zone"');
    expect(html).toContain('data-slot="sidebar-gap"');
  });

  it("drops the hover zone once the sidebar is expanded", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider defaultOpen>
        <Sidebar collapsible="offcanvas" />
      </SidebarProvider>,
    );

    expect(html).not.toContain('data-slot="sidebar-hover-zone"');
    expect(html).toContain('data-slot="sidebar-gap"');
  });

  it("keeps the sidebar trigger interactive inside Electron drag regions", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(html).toContain("[-webkit-app-region:no-drag]");
    expect(html).toContain("size-[var(--workspace-titlebar-control-size)]!");
  });

  it("uses shared geometry and icon constraints for menu buttons by default", () => {
    const html = renderSidebarButton();

    expect(html).toContain('data-slot="sidebar-menu-button"');
    expect(html).toContain("h-8");
    expect(html).toContain("rounded-[var(--control-radius)]");
    expect(html).toContain("px-[var(--sidebar-row-content-inset)]");
    expect(html).toContain("py-1.5");
    expect(html).toContain("]:size-4");
    expect(html).toContain("]:shrink-0");
    expect(html).toContain("cursor-pointer");
    expect(html).toContain("gap-[var(--sidebar-control-gap)]");
    expect(html).toContain("text-[var(--sidebar-icon-color)]");
    expect(html).not.toContain("[&amp;&gt;svg]:opacity-60");
  });

  it("applies the shared default treatment to icon-only menu buttons", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarMenuButton size="icon">
          <span>+</span>
        </SidebarMenuButton>
      </SidebarProvider>,
    );

    expect(html).toContain("size-8");
    expect(html).toContain("justify-center");
    expect(html).toContain("p-0");
    expect(html).toContain("font-medium");
    expect(html).toContain("text-sidebar-muted-foreground/80");
  });

  it("lets project drag handles override the default pointer cursor", () => {
    const html = renderSidebarButton("cursor-grab");

    expect(html).toContain("cursor-grab");
    expect(html).not.toContain("cursor-pointer");
  });

  it("uses a pointer cursor for menu actions", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuAction aria-label="Create thread">
        <span>+</span>
      </SidebarMenuAction>,
    );

    expect(html).toContain('data-slot="sidebar-menu-action"');
    expect(html).toContain("cursor-pointer");
  });

  it("uses a pointer cursor for submenu buttons", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuSubButton render={<button type="button" />}>Show more</SidebarMenuSubButton>,
    );

    expect(html).toContain('data-slot="sidebar-menu-sub-button"');
    expect(html).toContain("cursor-pointer");
  });
});
