import { Fragment, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { InfoHint } from "./InfoHint";
import { today, toIso } from "../dateRange";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A schema describes a calendar date when its description mentions the
// YYYY-MM-DD shape. The tool definitions in packages/agent/src/tools/defs/ use
// that phrasing consistently for every date-typed string parameter.
function isDateSchema(schema: JsonSchema): boolean {
  return /YYYY-MM-DD/.test(schema.description ?? "");
}

// Date fields that say "defaults to today" / "default today" / "Default: today"
// in their description should pre-fill today's date. DOB (no such phrasing) is
// left blank so the user actually enters their birthday.
function defaultsToToday(schema: JsonSchema): boolean {
  return /default[s]?:?\s+today\b/i.test(schema.description ?? "");
}

// Subset of JSON Schema we actually use in tool input_schemas. Kept loose
// because schemas arrive over the wire and we don't want to crash on a shape
// we haven't seen yet — fall back to a text input.
export type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: JsonSchema | boolean;
  // Sentinel for our renderer to skip a field outright (not standard JSON
  // Schema). Used by overrides that want to render a field differently.
  "x-hide"?: boolean;
  // Friendly display labels for enum values, parallel to `enum`. The stored
  // value still comes from `enum`; only the dropdown text changes.
  "x-enumLabels"?: string[];
};

type Path = ReadonlyArray<string | number>;

function setAt(value: unknown, path: Path, next: unknown): unknown {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  if (typeof head === "number") {
    const arr = Array.isArray(value) ? [...value] : [];
    arr[head] = setAt(arr[head], rest, next);
    return arr;
  }
  const obj = (value && typeof value === "object" ? { ...(value as object) } : {}) as Record<
    string,
    unknown
  >;
  obj[head] = setAt(obj[head], rest, next);
  return obj;
}

function deleteAt(value: unknown, path: Path): unknown {
  if (path.length === 0) return undefined;
  const [head, ...rest] = path;
  if (typeof head === "number") {
    const arr = Array.isArray(value) ? [...value] : [];
    if (rest.length === 0) arr.splice(head, 1);
    else arr[head] = deleteAt(arr[head], rest);
    return arr;
  }
  const obj = (value && typeof value === "object" ? { ...(value as object) } : {}) as Record<
    string,
    unknown
  >;
  if (rest.length === 0) delete obj[head];
  else obj[head] = deleteAt(obj[head], rest);
  return obj;
}

function humanizeKey(k: string): string {
  return k.replace(/_/g, " ");
}

function emptyForSchema(schema: JsonSchema | undefined): unknown {
  if (!schema) return "";
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (t === "number" || t === "integer") return 0;
  if (t === "boolean") return false;
  if (t === "array") return [];
  if (t === "object") {
    const out: Record<string, unknown> = {};
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if ((schema.required ?? []).includes(k)) {
          out[k] = emptyForSchema(sub);
        }
      }
    }
    return out;
  }
  return "";
}

export function ToolForm({
  schema,
  value,
  onChange,
  disabled,
}: {
  schema: JsonSchema;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
}) {
  return (
    <SchemaField
      schema={schema}
      value={value}
      path={[]}
      onChange={onChange}
      disabled={disabled}
      rootKey=""
      required
    />
  );
}

function SchemaField({
  schema,
  value,
  path,
  onChange,
  disabled,
  rootKey,
  required,
}: {
  schema: JsonSchema;
  value: unknown;
  path: Path;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  rootKey: string;
  required: boolean;
}) {
  const { t: tr } = useTranslation();
  if (schema["x-hide"]) return null;

  const update = (next: unknown) => onChange(next);

  // enum → Select. x-enumLabels (when present) drives display text; the
  // stored value still comes from schema.enum so the backend contract is
  // unchanged.
  if (Array.isArray(schema.enum)) {
    const opts = schema.enum.map((e) => String(e));
    const labels = schema["x-enumLabels"];
    const v = value == null ? "" : String(value);
    return (
      <Select value={v} onValueChange={(s) => update(s)} disabled={disabled}>
        <SelectTrigger className="h-9">
          <SelectValue placeholder={tr("formsAdmin.tool.choose")} />
        </SelectTrigger>
        <SelectContent>
          {opts.map((o, i) => (
            <SelectItem key={o} value={o}>
              {labels?.[i] ?? o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  if (t === "object") {
    return (
      <ObjectField
        schema={schema}
        value={(value as Record<string, unknown>) ?? {}}
        path={path}
        onChange={update}
        disabled={disabled}
        rootKey={rootKey}
      />
    );
  }

  if (t === "array") {
    return (
      <ArrayField
        schema={schema}
        value={Array.isArray(value) ? value : []}
        path={path}
        onChange={update}
        disabled={disabled}
        rootKey={rootKey}
      />
    );
  }

  if (t === "boolean") {
    const v = value === true;
    return (
      <label className="inline-flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={v}
          disabled={disabled}
          onChange={(e) => update(e.target.checked)}
          className="size-4"
        />
        <span className="text-muted-foreground">{schema.description ?? ""}</span>
      </label>
    );
  }

  if (t === "number" || t === "integer") {
    const v = value == null || value === "" ? "" : String(value);
    return (
      <Input
        type="number"
        step={t === "integer" ? "1" : "any"}
        value={v}
        disabled={disabled}
        required={required}
        placeholder={schema.description}
        onChange={(e) => {
          const s = e.target.value;
          if (s === "") update(undefined);
          else {
            const n = Number(s);
            update(Number.isFinite(n) ? n : s);
          }
        }}
        className="h-9"
      />
    );
  }

  // string (or unknown) — fall through to text. Use Textarea for longer
  // free-text fields when the description hints at multi-line content.
  const description = schema.description ?? "";
  const isLong = /describe|notes?|free.?text|reason/i.test(description);
  const v = value == null ? "" : String(value);
  if (isDateSchema(schema)) {
    return (
      <DateField
        value={v}
        description={description}
        disabled={disabled}
        required={required}
        defaultToToday={defaultsToToday(schema)}
        onChange={(next) => update(next || undefined)}
      />
    );
  }
  if (isLong) {
    return (
      <Textarea
        value={v}
        disabled={disabled}
        required={required}
        rows={2}
        placeholder={description}
        onChange={(e) => update(e.target.value || undefined)}
        className="min-h-15 resize-y"
      />
    );
  }
  return (
    <Input
      type="text"
      value={v}
      disabled={disabled}
      required={required}
      placeholder={description}
      onChange={(e) => update(e.target.value || undefined)}
      className="h-9"
    />
  );
}

function ObjectField({
  schema,
  value,
  path,
  onChange,
  disabled,
  rootKey,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  path: Path;
  onChange: (next: Record<string, unknown>) => void;
  disabled?: boolean;
  rootKey: string;
}) {
  const { t: tr } = useTranslation();
  // useMemo so the `{}` fallback keeps a stable identity, otherwise propEntries
  // below would recompute every render.
  const props = useMemo(() => schema.properties ?? {}, [schema.properties]);
  const requiredSet = new Set(schema.required ?? []);
  const propEntries = useMemo(() => Object.entries(props), [props]);

  // additionalProperties: a free-key map. Render as a list of (key, value)
  // rows below the fixed properties.
  const ap =
    schema.additionalProperties && typeof schema.additionalProperties === "object"
      ? schema.additionalProperties
      : null;

  const fixedKeys = new Set(propEntries.map(([k]) => k));
  const extraEntries = Object.entries(value ?? {}).filter(([k]) => !fixedKeys.has(k));

  return (
    <div
      className={cn(
        "space-y-3",
        path.length === 0 ? "" : "rounded-md border border-edge bg-background/40 p-2 shadow-well",
      )}
    >
      {propEntries.map(([k, sub]) => {
        if (sub["x-hide"]) return null;
        const childPath = [...path, k];
        const id = `${rootKey}.${k}`;
        const childValue = value?.[k];
        const isObjArr = sub.type === "object" || sub.type === "array";
        // Boolean fields render their description inline as the checkbox label,
        // so the (i) hint would just duplicate it.
        const isBool = sub.type === "boolean";
        return (
          <div key={id} className={cn(isObjArr ? "space-y-1" : "grid gap-1")}>
            <Label
              htmlFor={id}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground"
            >
              {humanizeKey(k)}
              {requiredSet.has(k) && <span className="text-destructive">*</span>}
              {sub.description && !isBool && <InfoHint text={sub.description} />}
            </Label>
            <SchemaField
              schema={sub}
              value={childValue}
              path={childPath}
              onChange={(next) => onChange(setAt(value, [k], next) as Record<string, unknown>)}
              disabled={disabled}
              rootKey={id}
              required={requiredSet.has(k)}
            />
          </div>
        );
      })}

      {ap && (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">{tr("formsAdmin.tool.extraEntries")}</div>
          {extraEntries.map(([k, v]) => {
            const id = `${rootKey}.x.${k}`;
            return (
              <div
                key={id}
                className="flex items-start gap-2 rounded-md border border-edge bg-background/40 p-2 shadow-well"
              >
                <div className="flex-1 space-y-1">
                  <Input
                    value={k}
                    disabled={disabled}
                    placeholder={tr("formsAdmin.tool.keyPlaceholder")}
                    onChange={(e) => {
                      const nextKey = e.target.value;
                      if (!nextKey || nextKey === k) return;
                      const obj = { ...(value ?? {}) };
                      delete obj[k];
                      obj[nextKey] = v;
                      onChange(obj);
                    }}
                    className="h-9"
                  />
                  <SchemaField
                    schema={ap}
                    value={v}
                    path={[...path, k]}
                    onChange={(next) =>
                      onChange(setAt(value, [k], next) as Record<string, unknown>)
                    }
                    disabled={disabled}
                    rootKey={id}
                    required={false}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  onClick={() => onChange(deleteAt(value, [k]) as Record<string, unknown>)}
                  aria-label={tr("formsAdmin.tool.removeKey", { key: k })}
                >
                  <X className="size-4" />
                </Button>
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              const base = "new_key";
              let i = 1;
              let key = base;
              while (key in (value ?? {})) {
                key = `${base}_${i++}`;
              }
              onChange({ ...(value ?? {}), [key]: emptyForSchema(ap) });
            }}
            className="gap-1"
          >
            <Plus className="size-3.5" />
            {tr("formsAdmin.tool.addEntry")}
          </Button>
        </div>
      )}
    </div>
  );
}

function ArrayField({
  schema,
  value,
  path,
  onChange,
  disabled,
  rootKey,
}: {
  schema: JsonSchema;
  value: unknown[];
  path: Path;
  onChange: (next: unknown[]) => void;
  disabled?: boolean;
  rootKey: string;
}) {
  const { t: tr } = useTranslation();
  const itemSchema = schema.items ?? {};
  const isObj = itemSchema.type === "object";

  return (
    <div className="space-y-2">
      {value.map((item, i) => {
        const id = `${rootKey}[${i}]`;
        return (
          <div
            key={id}
            className="flex items-start gap-2 rounded-md border border-edge bg-background/40 p-2 shadow-well"
          >
            <div className="min-w-0 flex-1">
              {isObj ? (
                <ObjectField
                  schema={itemSchema}
                  value={(item as Record<string, unknown>) ?? {}}
                  path={[...path, i]}
                  onChange={(next) => onChange(setAt(value, [i], next) as unknown[])}
                  disabled={disabled}
                  rootKey={id}
                />
              ) : (
                <SchemaField
                  schema={itemSchema}
                  value={item}
                  path={[...path, i]}
                  onChange={(next) => onChange(setAt(value, [i], next) as unknown[])}
                  disabled={disabled}
                  rootKey={id}
                  required={false}
                />
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              onClick={() => onChange(deleteAt(value, [i]) as unknown[])}
              aria-label={tr("formsAdmin.tool.removeRow")}
            >
              <X className="size-4" />
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onChange([...value, emptyForSchema(itemSchema)])}
        className="gap-1"
      >
        <Plus className="size-3.5" />
        {tr("formsAdmin.tool.addRow")}
      </Button>
    </div>
  );
}

function DateField({
  value,
  description,
  disabled,
  required,
  defaultToToday,
  onChange,
}: {
  value: string;
  description: string;
  disabled?: boolean;
  required: boolean;
  defaultToToday: boolean;
  onChange: (next: string) => void;
}) {
  const { t: tr } = useTranslation();
  // Pre-fill today when the schema documents it as the default and nothing
  // has been entered yet. Keeps the model's value if it already supplied one.
  useEffect(() => {
    if (defaultToToday && !value && !disabled) {
      onChange(toIso(today()));
    }
    // Fill-once default; guarded by !value, so re-running on value/onChange
    // is unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultToToday, disabled]);

  // Our DatePicker stores and emits ISO YYYY-MM-DD but renders DD-MM-YYYY.
  // If the model echoed something that isn't an ISO date (a stray phrase),
  // fall through to a plain text input rather than swallow the input.
  const isIso = !value || ISO_DATE.test(value);
  if (!isIso) {
    return (
      <Input
        type="text"
        value={value}
        disabled={disabled}
        required={required}
        placeholder={description}
        onChange={(e) => onChange(e.target.value)}
        className="h-9"
      />
    );
  }
  return (
    <DatePicker
      value={value}
      disabled={disabled}
      required={required}
      placeholder={description || tr("formsAdmin.tool.datePlaceholder")}
      onChange={onChange}
    />
  );
}

// Fragment export keeps the file ergonomic if we later split sub-components.
export { Fragment as _ToolFormFragment };
