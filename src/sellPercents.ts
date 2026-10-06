/** Share of a position a single sell button sells. 100 is a full close. */
export const SELL_PERCENTS = [10, 25, 50, 75, 100] as const;
export type SellPercent = (typeof SELL_PERCENTS)[number];
