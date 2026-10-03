/**
 * @ac game/Misc/DynamicVisibility.h
 * @ac game/Misc/DynamicVisibility.cpp
 *
 * pussywizard: dynamic visibility settings. The delay before the visibility of a moved unit is recomputed, the delay before
 * its AI is notified, and the distance it has to move first grow with the number of sessions: 7 player intervals (0-499,
 * 500-999, ... 3000+) and 5 map types (common, instance, raid, battleground, arena).
 */

/** @ac game/Misc/DynamicVisibility.h VisibilitySettingData */
interface VisibilitySettingData {
  visibilityNotifyDelay: number;
  aiNotifyDelay: number;
  requiredMoveDistanceSq: number;
}

/** @ac game/Misc/DynamicVisibility.h VISIBILITY_SETTINGS_PLAYER_INTERVAL */
export const VISIBILITY_SETTINGS_PLAYER_INTERVAL = 500;
/** @ac game/Misc/DynamicVisibility.h VISIBILITY_SETTINGS_MAX_INTERVAL_NUM */
export const VISIBILITY_SETTINGS_MAX_INTERVAL_NUM = 7;

const s = (visibilityNotifyDelay: number, aiNotifyDelay: number, requiredMoveDistanceSq: number): VisibilitySettingData => ({
  visibilityNotifyDelay,
  aiNotifyDelay,
  requiredMoveDistanceSq,
});

/** @ac game/Misc/DynamicVisibility.h VisibilitySettings */
const VisibilitySettings: readonly (readonly VisibilitySettingData[])[] = [
  [s(300, 150, 1.0), s(300, 150, 1.0), s(300, 150, 1.0), s(300, 150, 1.0), s(300, 150, 1.0)], // 0-499
  [s(400, 200, 2.25), s(400, 200, 2.25), s(400, 200, 2.25), s(300, 150, 1.0), s(300, 150, 1.0)], // 500-999
  [s(500, 250, 4.0), s(500, 250, 4.0), s(500, 250, 4.0), s(400, 200, 2.25), s(300, 150, 1.0)], // 1000-1499
  [s(700, 350, 6.25), s(700, 350, 6.25), s(700, 350, 6.25), s(600, 300, 6.25), s(300, 200, 1.0)], // 1500-1999
  [s(1000, 500, 16.0), s(1000, 500, 16.0), s(1000, 500, 16.0), s(1000, 500, 16.0), s(300, 250, 1.0)], // 2000-2499
  [s(1000, 500, 16.0), s(1000, 500, 16.0), s(1000, 500, 16.0), s(1000, 500, 16.0), s(300, 350, 1.0)], // 2500-2999
  [s(1200, 550, 20.0), s(1200, 550, 25.0), s(1200, 550, 25.0), s(1100, 550, 16.0), s(300, 350, 1.0)], // 3000+
];

/** @ac game/Misc/DynamicVisibility.h DynamicVisibilityMgr */
export const DynamicVisibilityMgr = {
  /** @ac game/Misc/DynamicVisibility.h DynamicVisibilityMgr::visibilitySettingsIndex */
  visibilitySettingsIndex: 0,

  /** @ac game/Misc/DynamicVisibility.cpp DynamicVisibilityMgr::Update */
  Update(sessionCount: number): void {
    if (sessionCount >= (this.visibilitySettingsIndex + 1) * VISIBILITY_SETTINGS_PLAYER_INTERVAL && this.visibilitySettingsIndex < VISIBILITY_SETTINGS_MAX_INTERVAL_NUM - 1) ++this.visibilitySettingsIndex;
    else if (this.visibilitySettingsIndex && sessionCount < this.visibilitySettingsIndex * VISIBILITY_SETTINGS_PLAYER_INTERVAL - 100) --this.visibilitySettingsIndex;
  },

  /** @ac game/Misc/DynamicVisibility.h DynamicVisibilityMgr::GetVisibilityNotifyDelay */
  GetVisibilityNotifyDelay(map_type: number): number {
    return VisibilitySettings[this.visibilitySettingsIndex]![map_type]!.visibilityNotifyDelay;
  },

  /** @ac game/Misc/DynamicVisibility.h DynamicVisibilityMgr::GetAINotifyDelay */
  GetAINotifyDelay(map_type: number): number {
    return VisibilitySettings[this.visibilitySettingsIndex]![map_type]!.aiNotifyDelay;
  },

  /** @ac game/Misc/DynamicVisibility.h DynamicVisibilityMgr::GetReqMoveDistSq */
  GetReqMoveDistSq(map_type: number): number {
    return VisibilitySettings[this.visibilitySettingsIndex]![map_type]!.requiredMoveDistanceSq;
  },
};
