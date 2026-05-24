export function now(): Date {
  return new Date();
}

export function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = parseDate(value);
  return parsed ? parsed.toISOString() : null;
}

export function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.valueOf()) ? null : value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number") {
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    return Number.isNaN(date.valueOf()) ? null : date;
  }
  const text = value.trim();
  if (!text) return null;
  const parsed = new Date(text.replace(/Z$/, "+00:00"));
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

export function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function localDayWindow(dateKey: string): { start: Date; end: Date } {
  const [yearText, monthText, dayText] = dateKey.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return { start, end };
}

export function overlapWindow(hours: number, end = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(end.getTime() - hours * 60 * 60 * 1000),
    end,
  };
}

export function ageMs(value: Date | null, at = new Date()): number | null {
  if (!value) return null;
  return Math.max(0, at.getTime() - value.getTime());
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      },
      { once: true },
    );
  });
}

