// Discord の ID（snowflake）と時刻の変換。上位 42 ビットが 2015-01-01 からのミリ秒。
export const DISCORD_EPOCH = 1420070400000n;

export function snowflakeToDate(id: string): Date {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

// その時刻以降の最小の ID（min_id / after に使う）
export function dateToSnowflake(date: Date): string {
  const ms = BigInt(date.getTime()) - DISCORD_EPOCH;
  if (ms < 0n) return "0";
  return (ms << 22n).toString();
}
