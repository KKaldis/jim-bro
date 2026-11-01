import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Check, Loader2, Pencil, Save, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ToolForm, type JsonSchema } from "./ToolForm";
import {
  approveActionKey,
  describeMutation,
  getOverride,
  getUpdateToolName,
  REPLACE_ID_KEY,
} from "./overrides";
import { useFormContext, type FormContext } from "./formContext";
import { CATEGORY_META, type ToolCategory } from "@/lib/toolCategory.tsx";

// Current wall-clock time as HH:MM, matching the `time` field contract.
function clockHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Default behaviour shared by every data-entry tool: when the schema exposes a
// plain `date` string, seed it with the day the UI is focused on (so logging
// follows the selected day, not always today). When it also exposes a `time`
// field AND the selected day IS today, seed the current clock time — a past day
// has no meaningful "now". Only fills keys the model omitted (callers merge the
// model's values on top), so an explicit date/time always wins.
function defaultDateTimePrefill(
  schema: JsonSchema | null,
  ctx: FormContext,
): Record<string, unknown> {
  const props = schema?.properties;
  if (!props) return {};
  const seed: Record<string, unknown> = {};
  if (props.date?.type === "string") seed.date = ctx.selectedDateIso;
  if (props.time?.type === "string" && ctx.isToday) seed.time = clockHHMM();
  return seed;
}

// Drop top-level keys whose (refined) schema marks them x-hide, so values left
// behind by a since-hidden field (e.g. a body_fat_pct typed before switching to
// the navy method) never reach the server.
function stripHidden(
  schema: JsonSchema | null,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const props = schema?.properties;
  if (!props) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (props[k]?.["x-hide"]) continue;
    out[k] = v;
  }
  return out;
}

export type ToolCardStatus =
  | "proposed" // gate pending — chip blings, modal offers Save or Cancel
  | "submitting" // POST to /chat/tool/.../confirm in flight
  | "saved" // gate resolved, tool ran successfully
  | "canceled" // user canceled, gate is closed
  | "error"; // server error during gate confirm or post-save update

export type ToolCardState = {
  status: ToolCardStatus;
  errorMessage?: string;
};

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aks = Object.keys(a as object);
  const bks = Object.keys(b as object);
  if (aks.length !== bks.length) return false;
  for (const k of aks) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) {
      return false;
    }
  }
  return true;
}

export function ToolFormCard({
  toolUseId,
  toolName,
  label,
  category,
  schema,
  proposedInput,
  identityPatch,
  state,
  onConfirm,
  onCancel,
  onUpdate,
}: {
  toolUseId: string;
  toolName: string;
  label: string;
  category: ToolCategory;
  schema: JsonSchema | null;
  proposedInput: Record<string, unknown>;
  // Identity folded back after a create-or-replace tool's first save (e.g.
  // {recipe_id} once save_recipe created the row). Merged into the working copy
  // so a later resubmit UPDATES that entry instead of creating a duplicate.
  identityPatch?: Record<string, unknown> | null;
  state: ToolCardState;
  // First-time confirmation (pre-execution gate). Resolved by the server's
  // /chat/tool/:id/confirm endpoint.
  onConfirm: (input: Record<string, unknown>) => void | Promise<void>;
  // Cancel the gate. Server gets {canceled: true}, the agent sees a
  // "canceled by user" tool_result.
  onCancel: () => void | Promise<void>;
  // Edit-after-save: re-runs the tool (or its update_* counterpart) directly
  // without going through the agent. Optional — for tools without an update
  // path, this is null and the resubmit button is hidden after save.
  onUpdate?: (input: Record<string, unknown>) => void | Promise<void>;
}) {
  const { t: tr } = useTranslation();
  // Local working copy. Initialized once from proposedInput; subsequent edits
  // are tracked here. Saved baseline is what we last submitted successfully.
  const [draft, setDraft] = useState<Record<string, unknown>>(proposedInput);
  const [baseline, setBaseline] = useState<Record<string, unknown>>(proposedInput);
  const [open, setOpen] = useState(false);

  // Shared profile / last-reading context for prefill + conditional fields.
  const { ctx, ready: ctxReady } = useFormContext();
  const prefillDone = useRef(false);

  // If the server pushes a new proposedInput (e.g. resumed history), reset
  // both draft and baseline to it. This only happens on first mount in
  // practice — subsequent prop changes are not expected.
  useEffect(() => {
    setDraft(proposedInput);
    setBaseline(proposedInput);
    prefillDone.current = false;
    // Reset only on a new card (toolUseId); re-running on proposedInput identity
    // would clobber the user's in-progress edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolUseId]);

  // Apply override prefill once the shared context resolves — only for keys
  // the model didn't already supply (model values win). Baseline is bumped in
  // step so the seeded value doesn't read as an unsaved edit.
  useEffect(() => {
    if (prefillDone.current || !ctxReady) return;
    prefillDone.current = true;
    // Generic date/time defaults first; the tool's bespoke prefill (and the
    // model's own values, applied in `merge`) take precedence over them.
    const prefill = {
      ...defaultDateTimePrefill(schema, ctx),
      ...getOverride(toolName)?.prefill?.(ctx),
    };
    if (Object.keys(prefill).length === 0) return;
    const merge = (prev: Record<string, unknown>) => {
      let changed = false;
      const next = { ...prev };
      for (const [k, v] of Object.entries(prefill)) {
        if (next[k] === undefined && v !== undefined) {
          next[k] = v;
          changed = true;
        }
      }
      return changed ? next : prev;
    };
    setDraft(merge);
    setBaseline(merge);
    // Prefill once per card when context resolves (prefillDone ref guards
    // re-entry); ctx/schema/toolName are read fresh at that point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxReady, toolUseId]);

  // Fold a post-create identity (e.g. {recipe_id}) into BOTH draft and baseline
  // the moment it arrives, so the card flips "from create turn to edit": the
  // next resubmit carries the id and updates that row instead of inserting a
  // duplicate. Merged, not reset — the user's in-progress edits are preserved,
  // and folding it into baseline keeps the seeded id from reading as a dirty
  // change. Idempotent: unchanged values short-circuit, so it can't loop.
  useEffect(() => {
    if (!identityPatch) return;
    const merge = (prev: Record<string, unknown>) => {
      let changed = false;
      const next = { ...prev };
      for (const [k, val] of Object.entries(identityPatch)) {
        if (next[k] !== val) {
          next[k] = val;
          changed = true;
        }
      }
      return changed ? next : prev;
    };
    setDraft(merge);
    setBaseline(merge);
  }, [identityPatch]);

  // Close the modal once an in-flight submit resolves (tool_finished arrives
  // via SSE and flips submitting → saved/canceled).
  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    if (
      prevStatusRef.current === "submitting" &&
      (state.status === "saved" || state.status === "canceled")
    ) {
      setOpen(false);
    }
    prevStatusRef.current = state.status;
  }, [state.status]);

  const dirty = useMemo(() => !deepEqual(draft, baseline), [draft, baseline]);
  const isPending = state.status === "proposed";
  const isSubmitting = state.status === "submitting";
  const isSaved = state.status === "saved";
  const isCanceled = state.status === "canceled";

  const updateToolName = getUpdateToolName(toolName);
  // Create-or-replace tools may only resubmit once their identity key is set —
  // otherwise the resubmit would insert a duplicate rather than update the row
  // the first save created. Normally the id is folded in after a create (see
  // identityPatch); if it's ever absent the card stays read-only after save.
  const replaceIdKey = REPLACE_ID_KEY[toolName];
  const hasReplaceId = replaceIdKey == null || draft[replaceIdKey] != null;
  const canResubmit = isSaved && updateToolName != null && onUpdate != null && hasReplaceId;
  const fieldsDisabled = isSubmitting || isCanceled || (isSaved && !canResubmit);

  const overrideDef = getOverride(toolName);
  const OverrideComponent = overrideDef?.component ?? null;
  const selfSubmitting = overrideDef?.selfSubmitting ?? false;

  // Schema tailored to the current draft + context (e.g. conditional field
  // visibility). Only the default <ToolForm> path consumes it; bespoke
  // override components get the raw schema.
  const refinedSchema = useMemo(
    () =>
      schema && overrideDef?.refineSchema ? overrideDef.refineSchema(schema, draft, ctx) : schema,
    [schema, overrideDef, draft, ctx],
  );

  const catMeta = CATEGORY_META[category];
  const CategoryIcon = catMeta.Icon;

  // What the pending chip is asking the user to approve: a single item's name,
  // or a batch count ("3 items"). Derived from the live draft so it tracks edits
  // made in the modal. Falls back to the tool label when nothing nameable.
  const mutation = useMemo(() => describeMutation(toolName, draft), [toolName, draft]);
  const chipTitle =
    mutation.count > 1
      ? tr("formsAdmin.batch.itemCount", { count: mutation.count })
      : (mutation.name ?? label);
  const approveLabel = tr(approveActionKey(toolName));

  const handleSubmit = async () => {
    if (isPending) {
      // First click: send through the gate. Strip fields hidden by the
      // refined schema so stale values can't leak into the tool call.
      await onConfirm(stripHidden(refinedSchema, draft));
      setBaseline(draft);
      return;
    }
    if (canResubmit && dirty) {
      await onUpdate!(stripHidden(refinedSchema, draft));
      setBaseline(draft);
    }
  };

  // Self-submitting overrides (e.g. ask_user's button picker) are a
  // conversational interaction, not a save-able form — they stay inline in
  // the bubble and commit the gate themselves on first interaction.
  if (selfSubmitting && OverrideComponent && schema) {
    const handleOverrideSubmit = (next: unknown) => {
      if (!isPending) return;
      const nextDraft = next as Record<string, unknown>;
      setDraft(nextDraft);
      setBaseline(nextDraft);
      void onConfirm(nextDraft);
    };
    return (
      <div
        className={cn(
          "rounded-lg border border-edge bg-card p-3 shadow-surface",
          state.status === "error" && "border-destructive/50",
        )}
      >
        <div className="mb-2 flex items-center justify-between gap-2 border-b pb-2">
          <div className="flex items-center gap-2 text-xs">
            <CategoryBadge category={category} />
            <span className="font-medium capitalize">{label}</span>
          </div>
          <StatusBadge state={state} />
        </div>
        <OverrideComponent
          schema={schema}
          value={draft}
          onChange={(next) => setDraft(next as Record<string, unknown>)}
          disabled={isSubmitting || isCanceled || !isPending}
          onSubmit={handleOverrideSubmit}
        />
        {/* Escape hatch: the wanted answer may not be among the offered
            options, and the message input stays disabled until this gate
            resolves. Cancelling sends a "canceled by user" result, ends the
            turn, and frees the user to type their own reply. */}
        {isPending && (
          <div className="mt-3 flex justify-start border-t pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void onCancel()}
              className="h-7 gap-1 text-xs text-muted-foreground"
            >
              <X className="size-3.5" />
              {tr("formsAdmin.tool.noneOfThese")}
            </Button>
          </div>
        )}
        {isCanceled && (
          <p className="mt-2 text-xs text-muted-foreground">
            {tr("formsAdmin.tool.canceledTypeReply")}
          </p>
        )}
        {state.errorMessage && (
          <p className="mt-2 text-xs text-destructive">{state.errorMessage}</p>
        )}
      </div>
    );
  }

  const chipIcon = isSubmitting ? (
    <Loader2 className="size-3.5 shrink-0 animate-spin" />
  ) : isSaved ? (
    <Check className="size-3.5 shrink-0" />
  ) : isCanceled ? (
    <X className="size-3.5 shrink-0" />
  ) : state.status === "error" ? (
    <AlertCircle className="size-3.5 shrink-0" />
  ) : (
    <Save className="size-3.5 shrink-0" />
  );

  return (
    <>
      {isPending ? (
        // Pending mutating-tool card: the title says WHAT is being changed (the
        // single item's name, or "N items" for a batch), and the blinged chip
        // holds all three CTAs — Edit opens the modal to review/adjust, Decline
        // cancels the gate, Approve commits the proposal directly (the escape
        // hatch for users who trust it and don't want to open the form). The
        // container itself is not clickable; the buttons carry the actions.
        <div
          className={cn(
            "tool-chip-bling flex w-full flex-col gap-2 rounded-lg border border-primary/60 bg-primary/10 px-3 py-2 text-start text-xs text-foreground shadow-control",
          )}
        >
          <div className="flex items-center gap-2">
            <CategoryIcon aria-hidden className={cn("size-3.5 shrink-0", catMeta.iconClass)} />
            <span className="truncate font-medium capitalize">{chipTitle}</span>
            <StatusBadge state={state} className="ms-auto shrink-0" />
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setOpen(true)}
              className="h-7 flex-1 gap-1 bg-background/60"
              title={tr("formsAdmin.tool.reviewAndEdit")}
            >
              <Pencil className="size-3.5" />
              {tr("common.edit")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void onCancel()}
              className="h-7 flex-1 gap-1 text-muted-foreground"
              title={tr("formsAdmin.tool.discard")}
            >
              <X className="size-3.5" />
              {tr("common.decline")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void handleSubmit()}
              className="h-7 flex-1 gap-1"
              title={tr("formsAdmin.tool.saveWithoutReviewing")}
            >
              <Check className="size-3.5" />
              {approveLabel}
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={
            isSaved
              ? canResubmit || updateToolName != null
                ? tr("formsAdmin.tool.viewOrEdit")
                : tr("formsAdmin.tool.view")
              : isCanceled
                ? tr("formsAdmin.tool.canceledView")
                : tr("formsAdmin.tool.open")
          }
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-start text-xs shadow-control transition-colors",
            // Post-entry chips get a thick dashed PRIMARY border on a transparent
            // ground (no shadow) so a saved input never reads as a solid result
            // card — those are bg-card filled with a shadow (cards/resultCards) —
            // and stays tied to the app's primary chrome, distinct from the muted
            // canceled state.
            isSubmitting &&
              "border-2 border-dashed border-primary/50 bg-transparent text-foreground shadow-none",
            isSaved &&
              "border-2 border-dashed border-primary/50 bg-transparent text-foreground shadow-none hover:bg-primary/10",
            isCanceled &&
              "border-2 border-dashed border-border bg-transparent text-muted-foreground shadow-none hover:bg-accent",
            state.status === "error" &&
              "border-2 border-dashed border-destructive/50 bg-transparent text-foreground shadow-none hover:bg-accent",
          )}
        >
          <CategoryIcon aria-hidden className={cn("size-3.5 shrink-0", catMeta.iconClass)} />
          <span className="truncate font-medium capitalize">{label}</span>
          <span className="shrink-0">{chipIcon}</span>
          <StatusBadge state={state} className="ms-auto shrink-0" />
        </button>
      )}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          // Closing the modal without saving discards in-progress edits: snap
          // the draft back to the last-saved baseline so reopening always shows
          // the committed values, not abandoned changes. (A successful save
          // already advanced baseline to the draft, so this is a no-op then.)
          if (!next) setDraft(baseline);
          setOpen(next);
        }}
      >
        <DialogContent
          className="modal-cap flex max-w-xl flex-col gap-0 overflow-hidden p-0"
          // Don't let Radix pull focus into the first field on open. These are
          // review-then-save cards, and the first field is often a combobox
          // (e.g. the recipe ingredient picker) whose focus handler pops its
          // suggestions open — jarring, and it invites editing an already-set
          // value. Open showing the values; the user clicks in to edit.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {/* Static header — stays pinned while the form body scrolls. */}
          <DialogHeader className="shrink-0 space-y-1.5 border-b bg-background px-6 py-4 pe-12">
            <DialogTitle className="flex items-center gap-2 text-base capitalize">
              <CategoryIcon aria-hidden className={cn("size-4 shrink-0", catMeta.iconClass)} />
              {label}
              <StatusBadge state={state} />
            </DialogTitle>
            {/* asChild → a <div>, not the default <p>: the CategoryBadge renders
                a <div>, which can't legally nest inside a <p>. */}
            <DialogDescription asChild className="flex flex-wrap items-center gap-1.5">
              <div>
                <CategoryBadge category={category} />
                {isPending && <span>{tr("formsAdmin.tool.reviewValues")}</span>}
                {isSaved && !canResubmit && <span>{tr("formsAdmin.tool.savedReadonly")}</span>}
                {isCanceled && <span>{tr("formsAdmin.tool.canceledNothingSaved")}</span>}
              </div>
            </DialogDescription>
          </DialogHeader>

          {/* Scrollable body — only the fields scroll. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {schema ? (
              OverrideComponent ? (
                <OverrideComponent
                  schema={schema}
                  value={draft}
                  onChange={(next) => setDraft(next as Record<string, unknown>)}
                  disabled={fieldsDisabled}
                />
              ) : (
                <ToolForm
                  schema={refinedSchema ?? schema}
                  value={draft}
                  onChange={(next) => setDraft(next as Record<string, unknown>)}
                  disabled={fieldsDisabled}
                />
              )
            ) : (
              <p className="text-xs text-muted-foreground">{tr("formsAdmin.tool.noSchema")}</p>
            )}

            {state.errorMessage && (
              <p className="mt-3 text-xs text-destructive">{state.errorMessage}</p>
            )}
          </div>

          {/* Static footer — Discard / Save stay pinned at the bottom. */}
          {(isPending || isSubmitting || isSaved) && (
            <DialogFooter className="shrink-0 border-t bg-background px-6 py-4">
              {isPending && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void onCancel()}
                  className="gap-1"
                >
                  <X className="size-3.5" />
                  {tr("formsAdmin.tool.discard")}
                </Button>
              )}
              {isSubmitting && (
                <Button type="button" size="sm" disabled className="gap-1">
                  <Loader2 className="size-3.5 animate-spin" />
                  {tr("common.saving")}
                </Button>
              )}
              {isPending && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleSubmit()}
                  className="gap-1"
                >
                  <Save className="size-3.5" />
                  {tr("common.save")}
                </Button>
              )}
              {isSaved && (
                <Button
                  type="button"
                  size="sm"
                  disabled={!canResubmit || !dirty}
                  onClick={() => void handleSubmit()}
                  className="gap-1"
                  title={
                    !canResubmit
                      ? tr("formsAdmin.tool.cantUpdateInPlace")
                      : dirty
                        ? tr("formsAdmin.tool.saveChanges")
                        : tr("formsAdmin.tool.noChangesToSave")
                  }
                >
                  <Check className="size-3.5" />
                  {dirty ? tr("formsAdmin.tool.update") : tr("formsAdmin.tool.saved")}
                </Button>
              )}
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// Small category chip — icon + label, tinted by category. Mirrors the pill
// tinting in Chat.tsx so a tool's category reads consistently across the gate
// card header and the chat pill.
function CategoryBadge({ category }: { category: ToolCategory }) {
  const meta = CATEGORY_META[category];
  const Icon = meta.Icon;
  return (
    <Badge variant="outline" className={cn("gap-1 font-normal", meta.badgeClass)}>
      <Icon aria-hidden className="size-3 shrink-0" />
      {meta.label}
    </Badge>
  );
}

function StatusBadge({ state, className }: { state: ToolCardState; className?: string }) {
  const { t: tr } = useTranslation();
  switch (state.status) {
    case "proposed":
      return (
        <Badge variant="outline" className={cn("font-normal", className)}>
          {tr("formsAdmin.tool.needsSave")}
        </Badge>
      );
    case "submitting":
      return (
        <Badge variant="outline" className={cn("font-normal", className)}>
          {tr("common.saving")}
        </Badge>
      );
    case "saved":
      return (
        <Badge variant="success" className={cn("font-normal", className)}>
          {tr("formsAdmin.tool.statusSaved")}
        </Badge>
      );
    case "canceled":
      return (
        <Badge variant="outline" className={cn("font-normal text-muted-foreground", className)}>
          {tr("formsAdmin.tool.statusCanceled")}
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive" className={cn("font-normal", className)}>
          {tr("formsAdmin.tool.error")}
        </Badge>
      );
  }
}
