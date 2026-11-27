// 通知の宛先（duet-send の --to）を決める。チャンネル → スレッドの親チャンネル → サーバー の順に、最初に載っているもの。
// どれも載っていなければ undefined（既定の宛先）。
export function resolveRoute(
  routes: ReadonlyMap<string, string> | undefined,
  place: { channelId: string; parentChannelId?: string | null; guildId?: string | null },
): string | undefined {
  if (!routes || routes.size === 0) return undefined;
  return (
    routes.get(place.channelId) ??
    (place.parentChannelId ? routes.get(place.parentChannelId) : undefined) ??
    (place.guildId ? routes.get(place.guildId) : undefined)
  );
}
