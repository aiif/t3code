import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadDetailsVisibility,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "./threadDetailsItems";

const usage = THREAD_DETAILS_ITEMS.find((item) => item.id === "usage")!;
const servers = THREAD_DETAILS_ITEMS.find((item) => item.id === "servers")!;

describe("thread details items", () => {
  it.each([
    { items: {}, usage: false, context: false },
    { items: { usage: true }, usage: true, context: false },
    { items: { usage: false, retired: false }, usage: false, context: false },
    { items: { context: true }, usage: false, context: true },
  ])("hides Usage and Context by default, overrides per item: %o", (row) => {
    const visibility = resolveThreadDetailsVisibility({ threadDetailsItems: row.items });
    expect(visibility.usage).toBe(row.usage);
    expect(visibility.context).toBe(row.context);
    expect(visibility.servers).toBe(true);
  });

  it("stores only choices that differ from the default", () => {
    const settings = { threadDetailsItems: {} };
    expect(setThreadDetailsItem(settings, usage, false)).toEqual({});
    expect(setThreadDetailsItem(settings, usage, true)).toEqual({ usage: true });

    const hidden = { threadDetailsItems: { servers: false } };
    expect(setThreadDetailsItem(hidden, servers, true)).toEqual({});
  });
});
