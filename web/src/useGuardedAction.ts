import { useCallback, useRef, useState } from "react";
import { SingleFlight } from "./requests.js";

/**
 * `SingleFlight` wired to a render: `run` refuses a second action while one
 * is in flight, and `busy` is what disables the controls while it does.
 *
 * Both halves are needed. The guard closes the gap a state flag leaves open
 * (a double-click lands before React has re-rendered anything); `busy` is
 * what tells the person, and it also holds a control disabled until the same
 * commit that shows the action's result - `setBusy(false)` lands in the batch
 * with whatever the action last set, so a confirm queue never renders the
 * next receipt with its Confirm button already live on the previous one.
 */
export function useGuardedAction(): {
  busy: boolean;
  run: (action: () => Promise<void>) => void;
} {
  const flight = useRef(new SingleFlight());
  const [busy, setBusy] = useState(false);
  const run = useCallback((action: () => Promise<void>) => {
    void flight.current.run(async () => {
      setBusy(true);
      try {
        await action();
      } finally {
        setBusy(false);
      }
    });
  }, []);
  return { busy, run };
}
