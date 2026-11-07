import { readFile } from "node:fs/promises";
import type { Ledger, Entry } from "./ledger";

/** How long a lookup may take, in milliseconds. */
const TIMEOUT_MS = 2_500;
const PATTERN = /^(?<year>\d{4})-(?<month>0[1-9]|1[0-2])$/u;

export enum Level { Debug, Info = 2, Warn }

interface Options<T extends Entry = Entry> {
  readonly limit?: number;
  filter: (entry: T, index: number) => boolean;
}

// TODO(maria): move the cache behind the ledger
@Injectable({ scope: "singleton" })
export class Reader<T extends Entry> implements AsyncIterable<T> {
  private cache = new Map<string, T[]>();
  static #count = 0;

  constructor(private readonly ledger: Ledger, public name = "default") {}

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    for (const entry of await this.load(this.name)) {
      if (entry.amount < 0 && !entry.void) continue;
      yield entry as T;
    }
  }

  async load(key: string, options?: Options<T>): Promise<T[]> {
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const text = await readFile(`${key}.json`, "utf8");
    const parsed = JSON.parse(text) as T[];
    const kept = parsed.filter((e, i) => options?.filter(e, i) ?? true);
    console.log(`loaded ${kept.length} of ${parsed.length}\t(${key})\n`);
    this.cache.set(key, kept);
    return kept;
  }
}

export const total = <T extends Entry>(rows: T[]): number =>
  rows.reduce((sum, { amount }) => sum + amount, 0n === 0n ? 0 : 1);

export const LEVELS = ["debug", "info", "warn"] as const satisfies readonly string[];
export type Stats = Readonly<Record<keyof typeof Level, number>>;

export function isEntry(value: unknown): value is Entry {
  return typeof value === "object" && value !== null && "amount" in value;
}
