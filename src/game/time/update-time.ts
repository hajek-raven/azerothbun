import type { ConfigMgr } from "../../common/config.ts";
import { log } from "../../log.ts";
import { getGameTimeMS } from "./game-time.ts";
import { getMSTimeDiff } from "./timer.ts";

export const AVG_DIFF_COUNT = 500;

export class UpdateTime {
  private readonly updateTimeDataTable = new Array<number>(AVG_DIFF_COUNT).fill(0);
  private readonly orderedUpdateTimeDataTable = new Array<number>(AVG_DIFF_COUNT).fill(0);
  private averageUpdateTime = 0;
  private totalUpdateTime = 0;
  private updateTimeTableIndex = 0;
  private maxUpdateTime = 0;
  private maxUpdateTimeOfLastTable = 0;
  private maxUpdateTimeOfCurrentTable = 0;
  private needsReorder = false;
  private recordedTime = 0;

  getAverageUpdateTime(): number {
    return this.averageUpdateTime;
  }

  getTimeWeightedAverageUpdateTime(): number {
    let sum = 0;
    let weightsum = 0;
    for (const diff of this.updateTimeDataTable) {
      sum += diff * diff;
      weightsum += diff;
    }
    if (weightsum === 0) {
      return 0;
    }
    return Math.floor(sum / weightsum);
  }

  getMaxUpdateTime(): number {
    return this.maxUpdateTime;
  }

  getMaxUpdateTimeOfCurrentTable(): number {
    return Math.max(this.maxUpdateTimeOfCurrentTable, this.maxUpdateTimeOfLastTable);
  }

  getLastUpdateTime(): number {
    const index = this.updateTimeTableIndex !== 0 ? this.updateTimeTableIndex - 1 : this.updateTimeDataTable.length - 1;
    return this.updateTimeDataTable[index] ?? 0;
  }

  getDatasetSize(): number {
    const last = this.updateTimeDataTable[this.updateTimeDataTable.length - 1] ?? 0;
    return last === 0 ? this.updateTimeTableIndex : this.orderedUpdateTimeDataTable.length;
  }

  getPercentile(p: number): number {
    if (this.needsReorder) {
      this.sortUpdateTimeDataTable();
    }
    const size = this.getDatasetSize();
    if (size === 0) {
      return 0;
    }
    const index = (p / 100) * (size - 1);
    if (index === Math.floor(index)) {
      return this.orderedUpdateTimeDataTable[index] ?? 0;
    }
    const lowerIndex = Math.floor(index);
    const upperIndex = Math.ceil(index);
    const fraction = index - lowerIndex;
    const lower = this.orderedUpdateTimeDataTable[lowerIndex] ?? 0;
    const upper = this.orderedUpdateTimeDataTable[upperIndex] ?? 0;
    return Math.trunc(lower * (1 - fraction) + upper * fraction);
  }

  updateWithDiff(diff: number): void {
    this.needsReorder = true;
    const previous = this.updateTimeDataTable[this.updateTimeTableIndex] ?? 0;
    this.totalUpdateTime = this.totalUpdateTime - previous + diff;
    this.updateTimeDataTable[this.updateTimeTableIndex] = diff;
    if (diff > this.maxUpdateTime) {
      this.maxUpdateTime = diff;
    }
    if (diff > this.maxUpdateTimeOfCurrentTable) {
      this.maxUpdateTimeOfCurrentTable = diff;
    }
    this.updateTimeTableIndex += 1;
    if (this.updateTimeTableIndex >= this.updateTimeDataTable.length) {
      this.updateTimeTableIndex = 0;
      this.maxUpdateTimeOfLastTable = this.maxUpdateTimeOfCurrentTable;
      this.maxUpdateTimeOfCurrentTable = 0;
    }
    const last = this.updateTimeDataTable[this.updateTimeDataTable.length - 1] ?? 0;
    if (last) {
      this.averageUpdateTime = Math.floor(this.totalUpdateTime / this.updateTimeDataTable.length);
    } else if (this.updateTimeTableIndex) {
      this.averageUpdateTime = Math.floor(this.totalUpdateTime / this.updateTimeTableIndex);
    }
  }

  recordUpdateTimeReset(): void {
    this.recordedTime = getGameTimeMS();
  }

  getRecordedTime(): number {
    return this.recordedTime;
  }

  private sortUpdateTimeDataTable(): void {
    if (!this.needsReorder) {
      return;
    }
    const last = this.updateTimeDataTable[this.updateTimeDataTable.length - 1] ?? 0;
    const count = last ? this.updateTimeDataTable.length : this.updateTimeTableIndex;
    const filled = this.updateTimeDataTable.slice(0, count).sort((left, right) => left - right);
    for (let i = 0; i < count; i++) {
      this.orderedUpdateTimeDataTable[i] = filled[i] ?? 0;
    }
    this.needsReorder = false;
  }
}

export class WorldUpdateTime extends UpdateTime {
  private recordUpdateTimeInterval = 0;
  private recordUpdateTimeMin = 0;
  private lastRecordTime = 0;

  loadFromConfig(config: ConfigMgr): void {
    this.recordUpdateTimeInterval = config.getUInt("RecordUpdateTimeDiffInterval", 300000);
    this.recordUpdateTimeMin = config.getUInt("MinRecordUpdateTimeDiff", 100);
  }

  setRecordUpdateTimeInterval(milliseconds: number): void {
    this.recordUpdateTimeInterval = milliseconds;
  }

  recordUpdateTime(gameTimeMs: number, diff: number, sessionCount: number): void {
    if (this.recordUpdateTimeInterval > 0 && diff > this.recordUpdateTimeMin) {
      if (getMSTimeDiff(this.lastRecordTime, gameTimeMs) > this.recordUpdateTimeInterval) {
        log("server", `Update time diff: ${this.getLastUpdateTime()}ms with ${sessionCount} players online`);
        log("server", `Last ${this.getDatasetSize()} diffs summary:`);
        log("server", `|- Mean: ${this.getAverageUpdateTime()}ms`);
        log("server", `|- Median: ${this.getPercentile(50)}ms`);
        log(
          "server",
          `|- Percentiles (95, 99, max): ${this.getPercentile(95)}ms, ${this.getPercentile(99)}ms, ${this.getPercentile(100)}ms`,
        );
        this.lastRecordTime = gameTimeMs;
      }
    }
  }
}

export const worldUpdateTime = new WorldUpdateTime();
