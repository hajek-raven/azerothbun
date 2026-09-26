import { urand } from "./random.ts";

export type TaskHandler = (context: TaskContext) => void;

type Task = {
  end: number;
  duration: number;
  group: number | null;
  repeated: number;
  run: TaskHandler;
  seq: number;
};

function randomDuration(min: number, max: number): number {
  return urand(min >>> 0, max >>> 0);
}

/**
 * `TaskScheduler`. `update(ms)` advances the scheduler clock.
 * `update()` with no duration snaps that clock to `performance.now()`, same as `steady_clock::now()`.
 */
export class TaskScheduler {
  private readonly owner = { scheduler: this as TaskScheduler | null };
  private now = performance.now();
  private predicate: () => boolean = () => true;
  private readonly tasks: Task[] = [];
  private readonly asyncs: Array<() => void> = [];
  private nextSeq = 1;

  constructor(predicate?: () => boolean) {
    if (predicate) {
      this.predicate = predicate;
    }
  }

  /** Drops the owner reference so contexts from this scheduler report `isExpired()`. */
  dispose(): void {
    this.owner.scheduler = null;
  }

  setValidator(predicate: () => boolean): this {
    this.predicate = predicate;
    return this;
  }

  clearValidator(): this {
    this.predicate = () => true;
    return this;
  }

  update(milliseconds?: number, callback: () => void = () => {}): this {
    if (milliseconds === undefined) {
      this.now = performance.now();
    } else {
      this.now += milliseconds;
    }
    this.dispatch(callback);
    return this;
  }

  async(callable: () => void): this {
    this.asyncs.push(callable);
    return this;
  }

  schedule(timeMs: number, task: TaskHandler): this;
  schedule(timeMs: number, group: number, task: TaskHandler): this;
  schedule(timeMs: number, groupOrTask: number | TaskHandler, task?: TaskHandler): this {
    if (typeof groupOrTask === "function") {
      return this.scheduleAt(this.now, timeMs, groupOrTask);
    }
    return this.scheduleAt(this.now, timeMs, task!, groupOrTask);
  }

  scheduleRange(minMs: number, maxMs: number, task: TaskHandler): this;
  scheduleRange(minMs: number, maxMs: number, group: number, task: TaskHandler): this;
  scheduleRange(minMs: number, maxMs: number, groupOrTask: number | TaskHandler, task?: TaskHandler): this {
    if (typeof groupOrTask === "function") {
      return this.schedule(randomDuration(minMs, maxMs), groupOrTask);
    }
    return this.schedule(randomDuration(minMs, maxMs), groupOrTask, task!);
  }

  cancelAll(): this {
    this.tasks.length = 0;
    this.asyncs.length = 0;
    return this;
  }

  cancelGroup(group: number): this {
    this.removeIf((task) => task.group === group);
    return this;
  }

  cancelGroupsOf(groups: readonly number[]): this {
    for (const group of groups) {
      this.cancelGroup(group);
    }
    return this;
  }

  isGroupScheduled(group: number): boolean {
    return this.tasks.some((task) => task.group === group);
  }

  /**
   * Milliseconds from the steady clock (`performance.now()`), not from the scheduler clock.
   * Matches `GetNextGroupOccurrence`, which subtracts `steady_clock::now()`.
   */
  getNextGroupOccurrence(group: number): number {
    let next = Number.POSITIVE_INFINITY;
    for (const task of this.tasks) {
      if (task.group === group && task.end < next) {
        next = task.end;
      }
    }
    return next - performance.now();
  }

  delayAll(duration: number): this {
    this.modifyIf(() => true, (task) => {
      task.end += duration;
    });
    return this;
  }

  delayAllRange(minMs: number, maxMs: number): this {
    return this.delayAll(randomDuration(minMs, maxMs));
  }

  delayGroup(group: number, duration: number): this {
    this.modifyIf((task) => task.group === group, (task) => {
      task.end += duration;
    });
    return this;
  }

  delayGroupRange(group: number, minMs: number, maxMs: number): this {
    return this.delayGroup(group, randomDuration(minMs, maxMs));
  }

  rescheduleAll(duration: number): this {
    const end = this.now + duration;
    this.modifyIf(() => true, (task) => {
      task.end = end;
    });
    return this;
  }

  rescheduleAllRange(minMs: number, maxMs: number): this {
    return this.rescheduleAll(randomDuration(minMs, maxMs));
  }

  rescheduleGroup(group: number, duration: number): this {
    const end = this.now + duration;
    this.modifyIf((task) => task.group === group, (task) => {
      task.end = end;
    });
    return this;
  }

  rescheduleGroupRange(group: number, minMs: number, maxMs: number): this {
    return this.rescheduleGroup(group, randomDuration(minMs, maxMs));
  }

  /** Used by `TaskContext` the way the C++ class is a friend of `TaskScheduler`. */
  scheduleAt(end: number, timeMs: number, task: TaskHandler, group?: number): this {
    this.insert({
      end: end + timeMs,
      duration: timeMs,
      group: group === undefined ? null : group,
      repeated: 0,
      run: task,
      seq: 0,
    });
    return this;
  }

  /** Used by `TaskContext.repeat`. */
  insert(task: Task): void {
    task.seq = this.nextSeq;
    this.nextSeq += 1;
    let i = this.tasks.length;
    while (i > 0 && taskBefore(task, this.tasks[i - 1]!)) {
      i -= 1;
    }
    this.tasks.splice(i, 0, task);
  }

  private dispatch(callback: () => void): void {
    if (!this.predicate()) {
      return;
    }
    while (this.asyncs.length > 0) {
      const callable = this.asyncs.shift()!;
      callable();
      if (!this.predicate()) {
        return;
      }
    }
    while (this.tasks.length > 0) {
      const first = this.tasks[0]!;
      if (first.end > this.now) {
        break;
      }
      this.tasks.shift();
      const context = new TaskContext(first, this.owner);
      context.invoke();
      if (!this.predicate()) {
        return;
      }
    }
    callback();
  }

  private removeIf(filter: (task: Task) => boolean): void {
    for (let i = 0; i < this.tasks.length;) {
      if (filter(this.tasks[i]!)) {
        this.tasks.splice(i, 1);
        continue;
      }
      i += 1;
    }
  }

  private modifyIf(filter: (task: Task) => boolean, change: (task: Task) => void): void {
    const cache: Task[] = [];
    for (let i = 0; i < this.tasks.length;) {
      const task = this.tasks[i]!;
      if (filter(task)) {
        change(task);
        cache.push(task);
        this.tasks.splice(i, 1);
        continue;
      }
      i += 1;
    }
    for (const task of cache) {
      this.insert(task);
    }
  }
}

function taskBefore(left: Task, right: Task): boolean {
  if (left.end < right.end) {
    return true;
  }
  if (left.end > right.end) {
    return false;
  }
  return left.seq < right.seq;
}

type Owner = { scheduler: TaskScheduler | null };

export class TaskContext {
  private readonly consumed = { value: false };

  constructor(
    private readonly task: Task | null,
    private readonly owner: Owner,
  ) {}

  isExpired(): boolean {
    return this.owner.scheduler === null;
  }

  isInGroup(group: number): boolean {
    return this.task?.group === group;
  }

  setGroup(group: number): this {
    if (this.task) {
      this.task.group = group;
    }
    return this;
  }

  clearGroup(): this {
    if (this.task) {
      this.task.group = null;
    }
    return this;
  }

  getRepeatCounter(): number {
    return this.task?.repeated ?? 0;
  }

  repeat(duration?: number): this;
  repeat(minMs: number, maxMs: number): this;
  repeat(duration?: number, maxMs?: number): this {
    if (this.consumed.value) {
      throw new Error("Bad task logic, task context was consumed already!");
    }
    if (!this.task) {
      throw new Error("Bad task logic, task context was consumed already!");
    }
    const next = maxMs === undefined ? (duration ?? this.task.duration) : randomDuration(duration ?? 0, maxMs);
    this.task.duration = next;
    this.task.end += next;
    this.task.repeated += 1;
    this.consumed.value = true;
    this.dispatch((scheduler) => {
      scheduler.insert(this.task!);
    });
    return this;
  }

  async(callable: () => void): this {
    return this.dispatch((scheduler) => scheduler.async(callable));
  }

  schedule(timeMs: number, task: TaskHandler): this;
  schedule(timeMs: number, group: number, task: TaskHandler): this;
  schedule(timeMs: number, groupOrTask: number | TaskHandler, task?: TaskHandler): this {
    const end = this.task?.end ?? 0;
    return this.dispatch((scheduler) => {
      if (typeof groupOrTask === "function") {
        scheduler.scheduleAt(end, timeMs, groupOrTask);
      } else {
        scheduler.scheduleAt(end, timeMs, task!, groupOrTask);
      }
    });
  }

  scheduleRange(minMs: number, maxMs: number, task: TaskHandler): this;
  scheduleRange(minMs: number, maxMs: number, group: number, task: TaskHandler): this;
  scheduleRange(minMs: number, maxMs: number, groupOrTask: number | TaskHandler, task?: TaskHandler): this {
    if (typeof groupOrTask === "function") {
      return this.schedule(randomDuration(minMs, maxMs), groupOrTask);
    }
    return this.schedule(randomDuration(minMs, maxMs), groupOrTask, task!);
  }

  cancelAll(): this {
    return this.dispatch((scheduler) => scheduler.cancelAll());
  }

  cancelGroup(group: number): this {
    return this.dispatch((scheduler) => scheduler.cancelGroup(group));
  }

  cancelGroupsOf(groups: readonly number[]): this {
    return this.dispatch((scheduler) => scheduler.cancelGroupsOf(groups));
  }

  delayAll(duration: number): this {
    return this.dispatch((scheduler) => scheduler.delayAll(duration));
  }

  delayGroup(group: number, duration: number): this {
    return this.dispatch((scheduler) => scheduler.delayGroup(group, duration));
  }

  rescheduleAll(duration: number): this {
    return this.dispatch((scheduler) => scheduler.rescheduleAll(duration));
  }

  rescheduleGroup(group: number, duration: number): this {
    return this.dispatch((scheduler) => scheduler.rescheduleGroup(group, duration));
  }

  invoke(): void {
    this.task?.run(this);
  }

  private dispatch(apply: (scheduler: TaskScheduler) => void): this {
    if (this.owner.scheduler) {
      apply(this.owner.scheduler);
    }
    return this;
  }
}
