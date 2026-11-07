import { Text, View } from "nsh";

import { Btn, NUM, Progress } from "#kit";
import { sizeText } from "#lib/files";
import type { Source } from "#lib/media-source";

/** A file of another machine being copied to this computer before it is shown: what is copied, how far, and `Cancel`. */
export function CopyProgress(props: { source: Source; machineName: string }) {
  const s = props.source;
  const how = () => `${sizeText(s.done())} of ${sizeText(s.total())}`;
  return (
    <View class="w-full max-w-md gap-3 px-6" accessibilityLabel="Copying the file" accessibilityState={{ busy: true }}>
      <Text class="text-center text-sm text-foreground">{`Copying from ${props.machineName}`}</Text>
      <Progress
        label="Copying the file"
        value={s.fraction() === null ? null : Math.round((s.fraction() ?? 0) * 100)}
        valueText={how()}
      />
      <Text style={NUM} class="text-center text-xs text-muted-foreground">
        {how()}
      </Text>
      <View class="items-center">
        <Btn label="Cancel" onPress={s.cancel} />
      </View>
    </View>
  );
}
