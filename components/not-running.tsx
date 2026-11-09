import { Btn, Empty } from "#kit";
import { runAction } from "#lib/actions";

/**
 * A pane herdr lists but could not bring back after it restarted. Nothing is read or typed: herdr's own reason stands where
 * the terminal (or the chat read from its log) would be, with the one thing to do. It shows whether or not the terminal tab is
 * on, because there is nothing to turn on (herdr-mobile's pane screen says the same).
 */
export function NotRunning(props: { reason?: string }) {
  return (
    <Empty fill icon="alert" title="Not running" hint={props.reason ?? "herdr could not restore this pane."}>
      <Btn label="Close pane" onPress={() => runAction("closePane")} />
    </Empty>
  );
}
