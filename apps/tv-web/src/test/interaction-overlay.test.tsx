import type { RoomInteractionEvent } from "@home-ktv/player-contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InteractionOverlay } from "../components/InteractionOverlay.js";

afterEach(() => {
  cleanup();
});

describe("InteractionOverlay", () => {
  it("renders emoji, text, rainbow praise, roast, and blessing interactions", () => {
    render(
      <InteractionOverlay
        interactions={[
          interaction("interaction-emoji", "emoji", "👏"),
          interaction("interaction-bullet", "bullet", "唱得太好了"),
          interaction("interaction-rainbow", "rainbow_praise", "这一开嗓，客厅都亮了"),
          interaction("interaction-roast", "roast", "这调跑得很有探索精神"),
          interaction("interaction-blessing", "blessing", "祝大家今晚玩得开心")
        ]}
      />
    );

    expect(screen.getByText("👏")).toBeTruthy();
    expect(screen.getByText("唱得太好了")).toBeTruthy();
    expect(screen.getByText("这一开嗓，客厅都亮了")).toBeTruthy();
    expect(screen.getByText("这调跑得很有探索精神")).toBeTruthy();
    expect(screen.getByText("祝大家今晚玩得开心")).toBeTruthy();
    expect(screen.getByTestId("rainbow-praise")).toBeTruthy();
    expect(screen.getByText("祝福")).toBeTruthy();
  });

  it("renders confetti particles when an emoji launches", () => {
    render(<InteractionOverlay interactions={[interaction("interaction-emoji", "emoji", "🚀")]} />);

    expect(screen.getByText("🚀")).toBeTruthy();
    expect(screen.getAllByTestId("emoji-confetti")).toHaveLength(12);
  });

  it("renders bullet comments as right-to-left marquee lanes for seven seconds", () => {
    render(<InteractionOverlay interactions={[interaction("interaction-bullet", "bullet", "一起合唱")]} />);

    const bullet = screen.getByTestId("bullet-marquee");
    expect(bullet.textContent).toContain("一起合唱");
    expect(bullet.style.animationDuration).toBe("7000ms");
    expect(bullet.style.animationName).toBe("ktv-bullet-marquee");
    expect(bullet.style.getPropertyValue("--ktv-bullet-y")).toMatch(/vh$/u);
  });

  it("renders rainbow praise as a dedicated seven second celebration overlay", () => {
    render(<InteractionOverlay interactions={[interaction("interaction-rainbow", "rainbow_praise", "这一开嗓，客厅都亮了")]} />);

    const rainbow = screen.getByTestId("rainbow-praise");
    expect(rainbow.textContent).toContain("彩虹屁");
    expect(rainbow.textContent).toContain("这一开嗓，客厅都亮了");
    expect(rainbow.style.animationDuration).toBe("7000ms");
    expect(rainbow.style.animationName).toBe("ktv-rainbow-praise-card");
    expect(screen.getAllByTestId("rainbow-spark")).toHaveLength(14);
  });

  it("renders roast messages on the marquee track with their own kind marker", () => {
    render(<InteractionOverlay interactions={[interaction("interaction-roast", "roast", "这调跑得很有探索精神")]} />);

    const roast = screen.getByTestId("bullet-marquee");
    expect(roast.getAttribute("data-kind")).toBe("roast");
    expect(roast.textContent).toContain("这调跑得很有探索精神");
    expect(roast.style.animationName).toBe("ktv-bullet-marquee");
  });

  it("renders bullet marquees with stable varied accent colors", () => {
    render(
      <InteractionOverlay
        interactions={Array.from({ length: 8 }, (_, index) =>
          interaction(`interaction-bullet-${index + 1}`, "bullet", `弹幕 ${index + 1}`)
        )}
      />
    );

    const bullets = screen.getAllByTestId("bullet-marquee");
    const accentColors = bullets.map((bullet) => bullet.style.getPropertyValue("--ktv-bullet-accent"));
    const firstGlow = bullets[0]?.querySelector("[aria-hidden='true']") as HTMLElement | null;

    expect(accentColors).toHaveLength(8);
    expect(accentColors.every((color) => /^#[0-9A-F]{6}$/u.test(color))).toBe(true);
    expect(new Set(accentColors).size).toBeGreaterThan(1);
    expect(firstGlow?.style.background).toContain("var(--ktv-bullet-accent");
  });

  it("stacks blessings newest first so later blessings push earlier ones downward", () => {
    render(
      <InteractionOverlay
        interactions={[
          interaction("interaction-blessing-old", "blessing", "第一条祝福", "2026-05-27T10:00:00.000Z"),
          interaction("interaction-blessing-new", "blessing", "第二条祝福", "2026-05-27T10:00:03.000Z")
        ]}
      />
    );

    const blessings = screen.getAllByTestId("blessing-stack-item");
    expect(blessings).toHaveLength(2);
    expect(blessings[0]?.textContent).toContain("第二条祝福");
    expect(blessings[1]?.textContent).toContain("第一条祝福");
    expect(blessings[0]?.style.animationDuration).toBe("7000ms");
  });

  it("does not clip a burst of blessing messages inside a short stack container", () => {
    render(
      <InteractionOverlay
        interactions={Array.from({ length: 8 }, (_, index) =>
          interaction(
            `interaction-blessing-${index + 1}`,
            "blessing",
            `祝福 ${index + 1}`,
            `2026-05-27T10:00:0${index}.000Z`
          )
        )}
      />
    );

    const blessings = screen.getAllByTestId("blessing-stack-item");
    expect(blessings).toHaveLength(8);
    expect(blessings[0]?.parentElement?.style.overflow).not.toBe("hidden");
    expect(blessings[0]?.parentElement?.style.maxHeight).not.toBe("46vh");
  });

  it("renders nothing without interactions", () => {
    const { container } = render(<InteractionOverlay interactions={[]} />);

    expect(container.textContent).toBe("");
  });
});

function interaction(
  id: string,
  kind: RoomInteractionEvent["kind"],
  message: string,
  createdAt = new Date(Date.now()).toISOString()
): RoomInteractionEvent {
  return {
    id,
    roomId: "living-room",
    roomSlug: "living-room",
    kind,
    message,
    senderDeviceId: "phone-a",
    senderName: "Controller A",
    createdAt,
    expiresAt: new Date(Date.now() + 12000).toISOString()
  };
}
