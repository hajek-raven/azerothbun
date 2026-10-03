import { afterEach, describe, expect, test } from "bun:test";
import { DynamicVisibilityMgr } from "./DynamicVisibility.ts";

afterEach(() => {
  DynamicVisibilityMgr.visibilitySettingsIndex = 0;
});

describe("DynamicVisibilityMgr", () => {
  test("the settings follow the session count in steps of 500, and fall back 100 sessions below a step", () => {
    expect(DynamicVisibilityMgr.GetVisibilityNotifyDelay(0)).toBe(300);
    expect(DynamicVisibilityMgr.GetAINotifyDelay(0)).toBe(150);
    expect(DynamicVisibilityMgr.GetReqMoveDistSq(0)).toBe(1.0);

    DynamicVisibilityMgr.Update(499);
    expect(DynamicVisibilityMgr.visibilitySettingsIndex).toBe(0);
    DynamicVisibilityMgr.Update(500);
    expect(DynamicVisibilityMgr.visibilitySettingsIndex).toBe(1);
    expect(DynamicVisibilityMgr.GetVisibilityNotifyDelay(0)).toBe(400);
    expect(DynamicVisibilityMgr.GetReqMoveDistSq(0)).toBe(2.25);
    // the bg and arena columns stay shorter
    expect(DynamicVisibilityMgr.GetVisibilityNotifyDelay(3)).toBe(300);

    // not yet back: 450 is above 500 - 100
    DynamicVisibilityMgr.Update(450);
    expect(DynamicVisibilityMgr.visibilitySettingsIndex).toBe(1);
    DynamicVisibilityMgr.Update(399);
    expect(DynamicVisibilityMgr.visibilitySettingsIndex).toBe(0);
  });

  test("the index stops at the last interval", () => {
    for (let i = 0; i < 20; i++) DynamicVisibilityMgr.Update(100000);
    expect(DynamicVisibilityMgr.visibilitySettingsIndex).toBe(6);
    expect(DynamicVisibilityMgr.GetVisibilityNotifyDelay(2)).toBe(1200);
    expect(DynamicVisibilityMgr.GetReqMoveDistSq(1)).toBe(25.0);
  });
});
