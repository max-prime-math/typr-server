import { describe, expect, it, vi } from "vitest";
import { ActivityBus } from "./activity.ts";

describe("management activity bus", () => {
  it("keeps bounded history and streams new structured events", () => {
    const bus = new ActivityBus(2);
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    bus.publish({ serviceId: "latex", level: "info", type: "start", message: "first" });
    bus.publish({ serviceId: "workspace", level: "warning", type: "write", message: "second" });
    const last = bus.publish({ serviceId: "latex", level: "error", type: "failure", message: "third" });
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(3);
    expect(bus.snapshot()).toHaveLength(2);
    expect(bus.snapshot({ serviceId: "latex" })).toEqual([last]);
    expect(bus.snapshot({ afterId: last.id })).toEqual([]);
  });
});
