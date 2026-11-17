export type ZoomStep = -1 | 0 | 1;

export function zoomShortcutStep(event:Pick<KeyboardEvent,'key'|'ctrlKey'|'metaKey'|'altKey'>):ZoomStep|undefined {
 if ((!event.ctrlKey && !event.metaKey) || event.altKey) return;
 if (event.key === '+' || event.key === '=') return 1;
 if (event.key === '-' || event.key === '_') return -1;
 if (event.key === '0') return 0;
}

export interface ZoomWheelAccumulator {delta:number;at:number}

/** Accumulate small trackpad deltas while keeping large wheel events bounded. */
export function wheelZoomSteps(event:Pick<WheelEvent,'deltaY'|'deltaMode'|'timeStamp'>,state:ZoomWheelAccumulator):number {
 if (event.timeStamp - state.at > 250) state.delta = 0;
 state.at = event.timeStamp;
 const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1);
 state.delta += pixels;
 const steps = Math.trunc(state.delta / 60);
 if (!steps) return 0;
 state.delta = state.delta % 60 || 0;
 return Math.max(-3,Math.min(3,-steps));
}
