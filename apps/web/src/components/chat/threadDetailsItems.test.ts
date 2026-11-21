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
    { items: {}, usage: true, context: true },
    { items: { usage: false }, usage: false, context: true },
    { items: { usage: true, retired: false }, usage: true, context: true },
    { items: { context: false }, usage: true, context: false },
  ])("shows Usage and Context by default, overrides per item: %o", (row) => {
    const visibility = resolveThreadDetailsVisibility({ threadDetailsItems: row.items });
    expect(visibility.usage).toBe(row.usage);
    expect(visibility.context).toBe(row.context);
    expect(visibility.servers).toBe(true);
  });

  it("stores only choices that differ from the default", () => {
    const settings = { threadDetailsItems: {} };
    expect(setThreadDetailsItem(settings, usage, false)).toEqual({ usage: false });
    expect(setThreadDetailsItem(settings, usage, true)).toEqual({});

    const hidden = { threadDetailsItems: { servers: false } };
    expect(setThreadDetailsItem(hidden, servers, true)).toEqual({});
  });
});
