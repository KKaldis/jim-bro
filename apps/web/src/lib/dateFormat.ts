// Single source of truth for date + time display formatting across the web
// app. Backend storage and API contracts stay ISO YYYY-MM-DD (the agent's
// tool schemas explicitly require it); every user-facing rendering passes
// through here so the UI is consistently DD-MM-YYYY and 24-hour.

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const DDMMYYYY_RE = /^(\d{2})-(\d{2})-(\d{4})$/;
const HHMM_RE = /^(\d{2}):(\d{2})$/;

// "2024-01-15" → "15-01-2024". Empty/invalid input passes through unchanged
// so callers can show whatever the model echoed (the ToolForm date field
// falls back to a plain text input in that case).
export function isoToDisplay(iso: string | null | undefined): string {
  if (!iso) return "";
  if (!ISO_RE.test(iso)) return iso;
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

// "15-01-2024" → "2024-01-15". Returns null on anything that isn't a real
// calendar date (e.g. 32-01-2024, 30-02-2024). Used by the picker before
// firing onChange so consumers always receive a valid ISO string.
export function displayToIso(display: string | null | undefined): string | null {
  if (!display) return null;
  const m = DDMMYYYY_RE.exec(display);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (year < 1900 || year > 2100) return null;
  const dt = new Date(year, month - 1, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) {
    return null;
  }
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export function isIsoDate(s: string | null | undefined): s is string {
  return !!s && ISO_RE.test(s);
}

export function isDisplayDate(s: string | null | undefined): boolean {
  return !!s && DDMMYYYY_RE.test(s) && displayToIso(s) !== null;
}

// Accept partial DD-MM-YYYY input as the user types and insert dashes
// automatically (e.g. "1501" → "15-01"). Non-digits are stripped. Used by
// the masked text input behind DatePicker.
export function maskDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}

// "HH:MM" pass-through. Accepts a Date, an ISO/datetime string, or an
// already-formatted "HH:MM" / "HH:MM:SS" string. Always returns 24-hour
// "HH:MM" or empty when the input can't be parsed.
export function formatTime24(input: Date | string | null | undefined): string {
  if (input == null || input === "") return "";
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return "";
    return `${String(input.getHours()).padStart(2, "0")}:${String(input.getMinutes()).padStart(
      2,
      "0",
    )}`;
  }
  if (HHMM_RE.test(input)) return input.slice(0, 5);
  if (/^\d{2}:\d{2}:\d{2}/.test(input)) return input.slice(0, 5);
  const dt = new Date(input);
  if (Number.isNaN(dt.getTime())) return "";
  return `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
}

// Auto-format partial HH:MM input. "1430" → "14:30"; strips non-digits;
// caps hours at 23 and minutes at 59 once they're clearly typed.
export function maskTimeInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 4);
  if (digits.length === 0) return "";
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

export function isValidTime24(s: string | null | undefined): boolean {
  if (!s) return false;
  const m = HHMM_RE.exec(s);
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}
