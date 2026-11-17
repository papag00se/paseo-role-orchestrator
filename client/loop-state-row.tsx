import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { z } from "zod";
import type { LoopRowSchema } from "../shared/loop-pause";

/** One quiet line in the timeline where a loop was paused or resumed. */
export function LoopStateRow({ item, theme, layout }: PluginTimelineItemProps<z.output<typeof LoopRowSchema>>) {
  return (
    <View style={{ paddingVertical: 4, paddingHorizontal: layout.compact ? 12 : 16 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" }}>{item.data.text}</Text>
    </View>
  );
}
