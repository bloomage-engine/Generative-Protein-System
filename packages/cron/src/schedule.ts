export type SchedulePreset = "hourly" | "daily" | "weekly";

export interface SchedulePresetOption {
  readonly id: SchedulePreset;
  readonly label: string;
}

export const SCHEDULE_PRESETS: readonly SchedulePresetOption[] = [
  { id: "hourly", label: "Every hour" },
  { id: "daily", label: "Every day" },
  { id: "weekly", label: "Every week" },
];

interface FieldSpec {
  readonly min: number;
  readonly max: number;
}

const MINUTE: FieldSpec = { min: 0, max: 59 };
const HOUR: FieldSpec = { min: 0, max: 23 };
const DAY_OF_MONTH: FieldSpec = { min: 1, max: 31 };
const MONTH: FieldSpec = { min: 1, max: 12 };
const DAY_OF_WEEK: FieldSpec = { min: 0, max: 6 };

const FIELDS: readonly FieldSpec[] = [MINUTE, HOUR, DAY_OF_MONTH, MONTH, DAY_OF_WEEK];

export type ParsedSchedule = readonly [
  ReadonlySet<number>,
  ReadonlySet<number>,
  ReadonlySet<number>,
  ReadonlySet<number>,
  ReadonlySet<number>,
];

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function isDigits(text: string | undefined): text is string {
  return text !== undefined && /^\d+$/.test(text);
}

function parseField(text: string, spec: FieldSpec): Set<number> | null {
  if (text === "") return null;
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [base, stepText, extra] = part.split("/");
    if (extra !== undefined) return null;
    let step = 1;
    if (stepText !== undefined) {
      if (!isDigits(stepText)) return null;
      step = Number(stepText);
      if (step < 1) return null;
    }
    let start: number;
    let end: number;
    if (base === "*") {
      start = spec.min;
      end = spec.max;
    } else if (base !== undefined && base.includes("-")) {
      const [from, to, dashExtra] = base.split("-");
      if (dashExtra !== undefined || !isDigits(from) || !isDigits(to)) return null;
      start = Number(from);
      end = Number(to);
    } else {
      if (!isDigits(base)) return null;
      start = Number(base);
      end = stepText === undefined ? start : spec.max;
    }
    if (start < spec.min || end > spec.max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseSchedule(expression: string): ParsedSchedule | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const parsed = parts.map((part, index) => parseField(part, FIELDS[index]!));
  if (parsed.some((field) => field === null)) return null;
  return parsed as unknown as ParsedSchedule;
}

export function isValidSchedule(expression: string): boolean {
  return parseSchedule(expression) !== null;
}

function isFull(values: ReadonlySet<number>, spec: FieldSpec): boolean {
  return values.size === spec.max - spec.min + 1;
}

export function matchesSchedule(expression: string, at: Date): boolean {
  const parsed = parseSchedule(expression);
  if (parsed === null) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed;
  return (
    minute.has(at.getMinutes()) &&
    hour.has(at.getHours()) &&
    dayOfMonth.has(at.getDate()) &&
    month.has(at.getMonth() + 1) &&
    dayOfWeek.has(at.getDay())
  );
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function describeSchedule(expression: string): string {
  const parsed = parseSchedule(expression);
  if (parsed === null) return expression;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed;
  const calendarFull = isFull(dayOfMonth, DAY_OF_MONTH) && isFull(month, MONTH);
  if (minute.size === 1 && hour.size === 24 && calendarFull && isFull(dayOfWeek, DAY_OF_WEEK)) {
    return `Every hour at :${pad2([...minute][0]!)}`;
  }
  if (minute.size === 1 && hour.size === 1 && calendarFull) {
    const time = `${pad2(hour.values().next().value!)}:${pad2(minute.values().next().value!)}`;
    if (isFull(dayOfWeek, DAY_OF_WEEK)) return `Every day at ${time}`;
    if (dayOfWeek.size === 1) return `Every ${WEEKDAYS[dayOfWeek.values().next().value!]} at ${time}`;
  }
  return expression;
}

export interface PresetOptions {
  /** 0-23; the default is 9. */
  hour?: number;
  /** 0-59; the default is 0. */
  minute?: number;
  /** 0 = Sunday … 6 = Saturday; the default is 1 (Monday). */
  weekday?: number;
}

export function presetToExpression(preset: SchedulePreset, options: PresetOptions = {}): string {
  const minute = options.minute ?? 0;
  const hour = options.hour ?? 9;
  const weekday = options.weekday ?? 1;
  switch (preset) {
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${weekday}`;
  }
}
