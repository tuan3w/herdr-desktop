import { cleanup } from "nsh";

/**
 * A timer that is gone with the component that made it: starting it again replaces the pending call. The guard after
 * a request appears, the 4 s a risky answer stays armed and the flash of a refusal are each one of these. Call it while
 * a component is being built, so `cleanup` has an owner.
 */
export function restartable() {
  let id: number | undefined;
  cleanup(() => clearTimeout(id));
  return {
    after(ms: number, run: () => void) {
      clearTimeout(id);
      id = setTimeout(run, ms);
    },
    stop() {
      clearTimeout(id);
      id = undefined;
    },
  };
}
