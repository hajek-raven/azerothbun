/**
 * Port of `deps/recastnavigation/Recast/Source/RecastFilter.cpp`.
 */
import {
  RC_NULL_AREA,
  RC_TIMER_FILTER_BORDER,
  RC_TIMER_FILTER_LOW_OBSTACLES,
  RC_TIMER_FILTER_WALKABLE,
  rcAbs,
  rcGetDirOffsetX,
  rcGetDirOffsetY,
  rcMax,
  rcMin,
  rcScopedTimer,
  type rcContext,
  type rcHeightfield,
} from "./Recast.ts";

/**
 * Marks non-walkable spans as walkable if their maximum is within `walkableClimb` of a walkable neighbor.
 * @ac deps/recastnavigation/Recast/Source/RecastFilter.cpp rcFilterLowHangingWalkableObstacles
 */
export function rcFilterLowHangingWalkableObstacles(ctx: rcContext, walkableClimb: number, solid: rcHeightfield): void {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_FILTER_LOW_OBSTACLES);

  const w = solid.width;
  const h = solid.height;
  const { smax, area, next } = solid.pools;

  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      let ps = 0;
      let previousWalkable = false;
      let previousArea = RC_NULL_AREA;

      for (let s = solid.spans[x + y * w]!; s; ps = s, s = next[s]!) {
        const walkable = area[s] !== RC_NULL_AREA;
        // If current span is not walkable, but there is walkable
        // span just below it, mark the span above it walkable too.
        if (!walkable && previousWalkable) {
          if (rcAbs(smax[s]! - smax[ps]!) <= walkableClimb) area[s] = previousArea;
        }
        // Copy walkable flag so that it cannot propagate
        // past multiple non-walkable objects.
        previousWalkable = walkable;
        previousArea = area[s]!;
      }
    }
  }
}

/**
 * Marks spans that are ledges as not-walkable.
 * @ac deps/recastnavigation/Recast/Source/RecastFilter.cpp rcFilterLedgeSpans
 */
export function rcFilterLedgeSpans(ctx: rcContext, walkableHeight: number, walkableClimb: number, solid: rcHeightfield): void {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_FILTER_BORDER);

  const w = solid.width;
  const h = solid.height;
  const MAX_HEIGHT = 0xffff;
  const { smin, smax, area, next } = solid.pools;
  const spans = solid.spans;

  // Mark border spans.
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      for (let s = spans[x + y * w]!; s; s = next[s]!) {
        // Skip non walkable spans.
        if (area[s] === RC_NULL_AREA) continue;

        const bot = smax[s]!;
        const sn = next[s]!;
        const top = sn ? smin[sn]! : MAX_HEIGHT;

        // Find neighbours minimum height.
        let minh = MAX_HEIGHT;

        // Min and max height of accessible neighbours.
        let asmin = smax[s]!;
        let asmax = smax[s]!;

        for (let dir = 0; dir < 4; ++dir) {
          const dx = x + rcGetDirOffsetX(dir);
          const dy = y + rcGetDirOffsetY(dir);
          // Skip neighbours which are out of bounds.
          if (dx < 0 || dy < 0 || dx >= w || dy >= h) {
            minh = rcMin(minh, -walkableClimb - bot);
            continue;
          }

          // From minus infinity to the first span.
          let ns = spans[dx + dy * w]!;
          let nbot = -walkableClimb;
          let ntop = ns ? smin[ns]! : MAX_HEIGHT;
          // Skip neightbour if the gap between the spans is too small.
          if (rcMin(top, ntop) - rcMax(bot, nbot) > walkableHeight) minh = rcMin(minh, nbot - bot);

          // Rest of the spans.
          for (ns = spans[dx + dy * w]!; ns; ns = next[ns]!) {
            nbot = smax[ns]!;
            const nn = next[ns]!;
            ntop = nn ? smin[nn]! : MAX_HEIGHT;
            // Skip neightbour if the gap between the spans is too small.
            if (rcMin(top, ntop) - rcMax(bot, nbot) > walkableHeight) {
              minh = rcMin(minh, nbot - bot);

              // Find min/max accessible neighbour height.
              if (rcAbs(nbot - bot) <= walkableClimb) {
                if (nbot < asmin) asmin = nbot;
                if (nbot > asmax) asmax = nbot;
              }
            }
          }
        }

        // The current span is close to a ledge if the drop to any
        // neighbour span is less than the walkableClimb.
        if (minh < -walkableClimb) {
          area[s] = RC_NULL_AREA;
        }
        // If the difference between all neighbours is too large,
        // we are at steep slope, mark the span as ledge.
        else if (asmax - asmin > walkableClimb) {
          area[s] = RC_NULL_AREA;
        }
      }
    }
  }
}

/**
 * Marks walkable spans as not walkable if the clearence above the span is less than the specified height.
 * @ac deps/recastnavigation/Recast/Source/RecastFilter.cpp rcFilterWalkableLowHeightSpans
 */
export function rcFilterWalkableLowHeightSpans(ctx: rcContext, walkableHeight: number, solid: rcHeightfield): void {
  using _timer = new rcScopedTimer(ctx, RC_TIMER_FILTER_WALKABLE);

  const w = solid.width;
  const h = solid.height;
  const MAX_HEIGHT = 0xffff;
  const { smin, smax, area, next } = solid.pools;

  // Remove walkable flag from spans which do not have enough
  // space above them for the agent to stand there.
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      for (let s = solid.spans[x + y * w]!; s; s = next[s]!) {
        const bot = smax[s]!;
        const sn = next[s]!;
        const top = sn ? smin[sn]! : MAX_HEIGHT;
        if (top - bot <= walkableHeight) area[s] = RC_NULL_AREA;
      }
    }
  }
}
