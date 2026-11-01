import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Camera,
  ChefHat,
  Loader2,
  PencilLine,
  Refrigerator,
  ScanBarcode,
  Search,
  Upload,
  PackageSearch,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { humanizeCategory, humanizeFoodName, macrosFor } from "@fa/shared";
import {
  getFoods,
  getFoodsBarcodeCode,
  getFoodsLookup,
  postFoodsScan,
  useGetPantry,
  useGetRecipes,
} from "./api/endpoints/default/default";
import type { BarcodeProduct } from "./api/model";
import { apiErr } from "./lib/apiErr";
import { runTool } from "./lib/runTool";
import { FeatureLock } from "./lib/features";
import { CameraModal } from "./components/CameraModal.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { isoToDisplay } from "./lib/dateFormat";
import { TimeInput } from "./components/ui/date-picker";
import { cn } from "./lib/utils";
import { BarcodeInput, MacroFields, type Macros as MacroValues } from "./forms/foodControls";
import {
  PantryItemFields,
  emptyPantryItemDraft,
  pantryDraftFields,
  type PantryItemDraft,
} from "./forms/PantryItemFields";
import { LogRecipeForm } from "./forms/LogRecipeForm";
import { LogMacroPreview } from "./forms/LogMacroPreview";
import type { JsonSchema } from "./forms/ToolForm";
import { ALLOWED_IMAGE_MIME, fileToBase64 } from "./lib/composerImages";
import { MEAL_SLOTS } from "./lib/mealSlots";

type Macros = { kcal: number; p: number; f: number; c: number; fiber?: number };
type FoodEntry = Macros & { category?: string; barcode?: string };
type FoodDb = Record<string, FoodEntry>;

// One row of the OpenFoodFacts `lookup_product` summary (see the agent's
// summarizeOffProduct). `per_100g` is null when the product exists but its
// nutriments are incomplete — we can't log macros for those.
type OffSummary = {
  name: string;
  brand: string | null;
  barcode: string | null;
  quantity: string | null;
  serving_size: string | null;
  image_url: string | null;
  suggested_snake_name: string;
  per_100g: Macros | null;
};

// A food the user selected, normalized across the three sources. `inDb` foods
// log by name (the server resolves macros + canonical name); everything else
// logs with explicit per-gram macros computed from `per100`.
type Picked = {
  food: string;
  label: string;
  per100: Macros | null;
  inDb: boolean;
  category?: string;
  barcode?: string;
  source: "db" | "pantry" | "openfoodfacts" | "image";
};

// Mirror of the server's RecognizedFood (apps/server/src/schemas.ts) — one
// food identified from a photo, with per-100g macros + a portion estimate.
type RecognizedFood = {
  food: string;
  display_name: string;
  per_100g: Macros | null;
  category: string | null;
  estimated_grams: number | null;
  confidence: "high" | "medium" | "low";
};

// A saved recipe as listed by GET /recipes (summary row, no resolved tree).
type RecipeMatch = {
  id: number;
  name: string;
  servings: number;
  favorite: boolean;
  kcal_per_serving: number;
  unresolved: number;
};

// LogRecipeForm takes a JsonSchema (the ToolOverrideProps contract) but renders
// bespoke fields, so an empty schema satisfies it.
const EMPTY_SCHEMA = { type: "object", properties: {} } as JsonSchema;

// Matches the server image limits (apps/server/src/schemas.ts).
const MAX_IMAGE_BYTES = 7_400_000;

// Normalize a free-typed custom name into the snake_case key the pantry/food
// catalog uses (e.g. "Chicken burrito" → "chicken_burrito"). Only used when the
// user opts to save a custom item back to the pantry for reuse.
function toSnakeName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Best-effort slot guess from the wall clock so the common case (logging a
// meal you just ate today) pre-fills sensibly. The user can always change it.
function defaultSlot(): (typeof MEAL_SLOTS)[number] {
  const h = new Date().getHours();
  if (h < 11) return "breakfast";
  if (h < 16) return "lunch";
  if (h < 21) return "dinner";
  return "snack";
}

// The wall-clock time as HH:MM — the default meal time, for the same reason.
function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function AddFoodDialog({
  open,
  onOpenChange,
  dateIso,
  onLogged,
  mode = "log",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dateIso: string;
  onLogged: () => void;
  // "log" (default) logs a meal to the day; "pantry" sets the picked food's
  // available grams in the pantry instead. Same search UX, different commit.
  mode?: "log" | "pantry";
}) {
  const { t } = useTranslation();
  const isPantry = mode === "pantry";
  // `db` is a cache of known catalog entries (macros/category), seeded from the
  // pantry's resolved foods and grown by each debounced search — not the whole
  // catalog. It backs the picked-food macros and row subtitles.
  const [db, setDb] = useState<FoodDb>({});
  const [pantry, setPantry] = useState<string[]>([]);
  const [q, setQ] = useState("");
  // Debounced server-side food search ("Foods" group). foodMatches holds the
  // matching catalog names from the latest /foods?query= response.
  const [foodMatches, setFoodMatches] = useState<string[]>([]);
  const [foodLoading, setFoodLoading] = useState(false);
  const [barcode, setBarcode] = useState("");
  const [off, setOff] = useState<OffSummary[] | null>(null);
  const [offLoading, setOffLoading] = useState(false);
  const [offError, setOffError] = useState<string | null>(null);

  // Photo recognition (take photo / upload image → /foods/scan).
  const [scan, setScan] = useState<RecognizedFood[] | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // On-device barcode scan (camera → decode locally → /foods/barcode cascade).
  const [scanCameraOpen, setScanCameraOpen] = useState(false);
  const [barcodeLoading, setBarcodeLoading] = useState(false);
  const [barcodeError, setBarcodeError] = useState<string | null>(null);

  const [picked, setPicked] = useState<Picked | null>(null);
  // A saved recipe picked from search (log mode only) — logged via log_recipe
  // through the shared LogRecipeForm, by servings or by weight.
  const [pickedRecipe, setPickedRecipe] = useState<RecipeMatch | null>(null);
  const [recipeDraft, setRecipeDraft] = useState<Record<string, unknown>>({});
  // When true, show the free-form custom-food form instead of search/confirm —
  // for logging delivery / restaurant food that isn't in the pantry (log mode
  // only). See CustomFoodStep.
  const [custom, setCustom] = useState(false);
  // Pantry mode's equivalent: hand-enter a brand-new product (name + per-100g
  // macros + stock) that isn't in the catalog or OFF. See CustomPantryStep.
  const [customPantry, setCustomPantry] = useState(false);
  // When the on-device scan is triggered from the manual-entry form, its result
  // prefills that form (below) instead of running the search/pick cascade.
  const [scanForPrefill, setScanForPrefill] = useState(false);
  const [pantryPrefill, setPantryPrefill] = useState<{
    nonce: number;
    barcode: string;
    name?: string;
    macros?: MacroValues;
  } | null>(null);
  const prefillNonce = useRef(0);
  const [grams, setGrams] = useState(100);
  const [slot, setSlot] = useState<string>(defaultSlot());
  // HH:MM the meal was eaten at — defaults to now; clearing it logs untimed.
  const [time, setTime] = useState(nowTime);
  // Pantry-add only: the unit the quantity is measured in.
  const [pantryUnit, setPantryUnit] = useState<"g" | "ml" | "pcs">("g");
  const [logging, setLogging] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  // Reset everything each time the dialog opens. The pantry (the user's own
  // items + their `foods` macro map) is loaded by the query below.
  useEffect(() => {
    if (!open) return;
    setQ("");
    setBarcode("");
    setOff(null);
    setOffError(null);
    setScan(null);
    setScanError(null);
    setScanLoading(false);
    setCameraOpen(false);
    setScanCameraOpen(false);
    setBarcodeLoading(false);
    setBarcodeError(null);
    setPicked(null);
    setPickedRecipe(null);
    setRecipeDraft({});
    setCustom(false);
    setCustomPantry(false);
    setScanForPrefill(false);
    setPantryPrefill(null);
    setGrams(100);
    setSlot(defaultSlot());
    setTime(nowTime());
    setLogError(null);
    setFoodMatches([]);
    setFoodLoading(false);
    setDb({});
  }, [open]);

  // Pantry (only fetched while the dialog is open): names back the "from your
  // pantry" suggestions; `foods` seeds the entry cache so pantry rows show
  // macros and log by name. The catalog is searched on demand below.
  const pantryQ = useGetPantry(undefined, { query: { enabled: open } });
  useEffect(() => {
    if (!pantryQ.data) return;
    const items = (pantryQ.data.items as Array<{ name: string }>) ?? [];
    setPantry(items.map((it) => it.name).sort());
    const foods = pantryQ.data.foods as FoodDb | undefined;
    if (foods) setDb((prev) => ({ ...prev, ...foods }));
  }, [pantryQ.data]);

  // Debounced combined search: on a paused keystroke, search the pantry catalog
  // (/foods) AND our food index (/foods/lookup — OpenFoodFacts + USDA, the
  // "other" databases) in parallel. Results render pantry-first, then the food
  // index below, so both sources are always searched without an extra tap. The
  // two requests share one debounce + cancel guard.
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (term.length < 2) {
      setFoodMatches([]);
      setFoodLoading(false);
      setOff(null);
      setOffError(null);
      setOffLoading(false);
      return;
    }
    setFoodLoading(true);
    setOffLoading(true);
    let cancelled = false;
    const handle = setTimeout(() => {
      // Pantry catalog — matched entries merge into `db` (backs macros/subtitles).
      void (async () => {
        try {
          const matches = (await getFoods({ query: term })) as unknown as FoodDb;
          if (cancelled) return;
          setDb((prev) => ({ ...prev, ...matches }));
          setFoodMatches(Object.keys(matches).sort());
        } catch {
          // Pantry search just won't return results; the food index + barcode still work.
        } finally {
          if (!cancelled) setFoodLoading(false);
        }
      })();
      // Food index (OpenFoodFacts + USDA). Silent on empty/error while typing —
      // the group only appears once there's something to show, so mid-type
      // keystrokes don't flash an error.
      void (async () => {
        try {
          const json = (await getFoodsLookup({ query: term })) as {
            error?: string;
            product?: OffSummary;
            results?: OffSummary[];
          };
          if (cancelled) return;
          const list = json.error ? [] : (json.results ?? (json.product ? [json.product] : []));
          setOff(list.length ? list : null);
          setOffError(null);
        } catch {
          if (!cancelled) setOff(null);
        } finally {
          if (!cancelled) setOffLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q, open]);

  // Saved recipes (log mode only) — a short list, so filtered client-side.
  // Favourites lead; with no query the first few show as quick picks.
  const recipesQ = useGetRecipes({ query: { enabled: open && !isPantry } });
  const recipeMatches = useMemo(() => {
    if (isPantry) return [];
    const all = (recipesQ.data?.recipes ?? []) as RecipeMatch[];
    const term = q.toLowerCase().trim();
    return all
      .filter((r) => !term || r.name.toLowerCase().includes(term))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name))
      .slice(0, term ? 20 : 5);
  }, [recipesQ.data, q, isPantry]);

  const pickRecipe = (r: RecipeMatch) => {
    setPickedRecipe(r);
    setRecipeDraft({ recipe_id: r.id, name: r.name, date: dateIso, slot, time: time || undefined });
    setLogError(null);
  };

  const pantryMatches = useMemo(() => {
    const term = q.toLowerCase().trim();
    const list = term
      ? pantry.filter(
          (n) => n.toLowerCase().includes(term) || humanizeFoodName(n).toLowerCase().includes(term),
        )
      : pantry;
    return list.slice(0, 30);
  }, [pantry, q]);

  const pickDb = (name: string, source: "db" | "pantry") => {
    const entry = db[name];
    setPicked({
      food: name,
      label: humanizeFoodName(name),
      per100: entry ?? null,
      inDb: entry != null,
      category: entry?.category,
      barcode: entry?.barcode,
      source,
    });
    setLogError(null);
  };

  const pickOff = (p: OffSummary) => {
    setPicked({
      food: p.suggested_snake_name,
      label: [p.brand, p.name].filter(Boolean).join(" — ") || p.name,
      per100: p.per_100g,
      inDb: false,
      ...(p.barcode ? { barcode: p.barcode } : {}),
      source: "openfoodfacts",
    });
    setLogError(null);
  };

  // A scanned-barcode hit. Pantry items log by name (the server resolves their
  // macros + canonical name, like other in-DB foods); food-index products
  // (off/usda) carry explicit per-100g macros, logged like an OpenFoodFacts pick.
  const pickBarcode = (p: BarcodeProduct) => {
    const fromPantry = p.source === "pantry";
    setPicked({
      food: p.suggested_snake_name,
      label: p.brand ? `${p.brand} — ${p.name}` : p.name,
      per100: p.per_100g,
      inDb: fromPantry,
      ...(p.barcode ? { barcode: p.barcode } : {}),
      source: fromPantry ? "pantry" : "openfoodfacts",
    });
    setLogError(null);
  };

  // A photo-recognized food logs with explicit per-gram macros (like OFF), and
  // prefills grams with the model's portion estimate so the common case is one
  // tap to confirm.
  const pickImage = (f: RecognizedFood) => {
    setPicked({
      food: f.food,
      label: f.display_name,
      per100: f.per_100g,
      inDb: false,
      category: f.category ?? undefined,
      source: "image",
    });
    setGrams(f.estimated_grams && f.estimated_grams > 0 ? f.estimated_grams : 100);
    setLogError(null);
  };

  async function runScan(file: File | undefined) {
    if (!file) return;
    setScanError(null);
    if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(file.type)) {
      setScanError(t("nutrition.add.unsupportedImage"));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setScanError(t("nutrition.add.imageTooLarge"));
      return;
    }
    setScanLoading(true);
    setScan(null);
    try {
      const data = await fileToBase64(file);
      const json = (await postFoodsScan({
        image: { media_type: file.type as never, data },
      })) as { items?: RecognizedFood[]; note?: string };
      const items = json.items ?? [];
      setScan(items);
      if (!items.length) {
        setScanError(json.note || t("nutrition.add.noFoodRecognized"));
      }
    } catch (e) {
      setScanError(apiErr(e));
      setScan([]);
    } finally {
      setScanLoading(false);
    }
  }

  // Deterministic barcode resolution (tier 1+2 of the scan cascade): the camera
  // decoded the code on-device, we resolve it pantry-first → food index here.
  // A hit auto-selects the product; a miss prefills the manual barcode field and
  // points the user at the photo/AI fallback (the code is valid, just unknown).
  async function runBarcode(code: string) {
    setScanCameraOpen(false);
    setBarcodeError(null);
    setBarcodeLoading(true);
    try {
      const res = await getFoodsBarcodeCode(code);
      if (res.found && res.product) {
        pickBarcode(res.product);
        return;
      }
      setBarcode(res.barcode || code);
      setBarcodeError(t("nutrition.add.barcodeNotFound", { code: res.barcode || code }));
    } catch (e) {
      setBarcodeError(apiErr(e));
    } finally {
      setBarcodeLoading(false);
    }
  }

  // Scan invoked from the manual-entry form: resolve the code, then prefill the
  // form rather than jumping to the confirm step. A hit fills name + macros +
  // barcode (still editable); a miss just fills the barcode so the user carries
  // on entering the facts by hand.
  async function runBarcodePrefill(code: string) {
    setScanCameraOpen(false);
    setScanForPrefill(false);
    setBarcodeError(null);
    setBarcodeLoading(true);
    try {
      const res = await getFoodsBarcodeCode(code);
      const bc = res.barcode || code;
      if (res.found && res.product) {
        const p = res.product;
        setPantryPrefill({
          nonce: (prefillNonce.current += 1),
          barcode: p.barcode || bc,
          name: humanizeFoodName(p.suggested_snake_name),
          ...(p.per_100g ? { macros: p.per_100g } : {}),
        });
      } else {
        setPantryPrefill({ nonce: (prefillNonce.current += 1), barcode: bc });
        setBarcodeError(t("nutrition.add.barcodeScannedManual", { code: bc }));
      }
    } catch (e) {
      setBarcodeError(apiErr(e));
    } finally {
      setBarcodeLoading(false);
    }
  }

  // Commit a hand-entered product to the pantry. Same update_pantry shape as
  // addToPantry, but the macros/category/barcode come from the form rather than
  // a picked source. Macros are per-100g (the pantry's storage convention).
  async function saveCustomPantry(name: string, fields: Record<string, unknown>) {
    setLogging(true);
    setLogError(null);
    try {
      const error = await runTool("update_pantry", {
        items: { [toSnakeName(name)]: fields },
        mode: "merge",
      });
      if (error) {
        setLogError(error);
        return;
      }
      onLogged();
      onOpenChange(false);
    } catch (e) {
      setLogError(e instanceof Error ? e.message : String(e));
    } finally {
      setLogging(false);
    }
  }

  async function runOff(params: { query?: string; barcode?: string }) {
    setOffLoading(true);
    setOffError(null);
    try {
      const json = (await getFoodsLookup({
        ...(params.barcode ? { barcode: params.barcode } : {}),
        ...(params.query ? { query: params.query } : {}),
      })) as {
        found?: boolean;
        product?: OffSummary;
        results?: OffSummary[];
        error?: string;
      };
      if (json.error) {
        setOffError(json.error);
        setOff([]);
        return;
      }
      const list = json.results ?? (json.product ? [json.product] : []);
      setOff(list);
    } catch (e) {
      setOffError(apiErr(e));
      setOff([]);
    } finally {
      setOffLoading(false);
    }
  }

  const scaled = useMemo(() => {
    if (!picked?.per100) return null;
    return macrosFor(picked.per100, grams);
  }, [picked, grams]);

  async function addToPantry() {
    if (!picked) return;
    if (!Number.isFinite(grams) || grams < 0) {
      setLogError(t("nutrition.add.quantityInvalid"));
      return;
    }
    // The pantry now carries the food's facts too, so persist macros / category
    // / barcode when the picked source has them (OFF, photo, or an existing
    // pantry food). Macro-less picks still add as a name + quantity.
    setLogging(true);
    setLogError(null);
    try {
      const fields: Record<string, unknown> = {
        quantity: grams,
        unit: pantryUnit,
      };
      if (picked.per100) fields.macros = picked.per100;
      if (picked.category) fields.category = picked.category;
      if (picked.barcode) fields.barcode = picked.barcode;
      const error = await runTool("update_pantry", {
        items: { [picked.food]: fields },
        mode: "merge",
      });
      if (error) {
        setLogError(error);
        return;
      }
      onLogged();
      onOpenChange(false);
    } catch (e) {
      setLogError(e instanceof Error ? e.message : String(e));
    } finally {
      setLogging(false);
    }
  }

  async function logIt() {
    if (!picked) return;
    if (!Number.isFinite(grams) || grams <= 0) {
      setLogError(t("nutrition.add.gramsInvalid"));
      return;
    }
    // Foods we don't have macros for can only log if they resolve server-side
    // by name; OFF results without per_100g can't be logged at all.
    if (!picked.inDb && !picked.per100) {
      setLogError(t("nutrition.add.noMacros"));
      return;
    }
    // In-DB foods log by name (server resolves macros + canonical name);
    // OFF products carry explicit per-gram macros computed from per_100g.
    const item = picked.inDb
      ? { food: picked.food, grams }
      : {
          food: picked.food,
          grams,
          kcal: Math.round(scaled!.kcal),
          p: Math.round(scaled!.p * 10) / 10,
          f: Math.round(scaled!.f * 10) / 10,
          c: Math.round(scaled!.c * 10) / 10,
          ...(scaled!.fiber != null ? { fiber: Math.round(scaled!.fiber * 10) / 10 } : {}),
        };
    setLogging(true);
    setLogError(null);
    try {
      const error = await runTool("log_meal", {
        date: dateIso,
        slot,
        ...(time ? { time } : {}),
        items: [item],
      });
      if (error) {
        setLogError(error);
        return;
      }
      onLogged();
      onOpenChange(false);
    } catch (e) {
      setLogError(e instanceof Error ? e.message : String(e));
    } finally {
      setLogging(false);
    }
  }

  async function logRecipe() {
    if (!pickedRecipe) return;
    if (recipeDraft.grams != null && !(Number(recipeDraft.grams) > 0)) {
      setLogError(t("nutrition.add.gramsInvalid"));
      return;
    }
    setLogging(true);
    setLogError(null);
    try {
      const error = await runTool("log_recipe", recipeDraft);
      if (error) {
        setLogError(error);
        return;
      }
      onLogged();
      onOpenChange(false);
    } finally {
      setLogging(false);
    }
  }

  // Log a free-form custom meal (delivery / eating out). Macros are entered as
  // TOTALS for the portion, so they're sent inline to log_meal verbatim (the
  // server stores manual items as-is — no pantry lookup). Optionally derive
  // per-100g macros and save the item to the pantry catalog for reuse.
  async function logCustom(v: {
    name: string;
    barcode: string | null;
    grams: number;
    macros: Macros;
    slot: string;
    time: string;
    saveToPantry: boolean;
  }) {
    setLogging(true);
    setLogError(null);
    try {
      if (v.saveToPantry) {
        // macrosFor(x, g) = x * g/100, so per-100g = totals * 100/grams.
        const per100 = macrosFor(v.macros, 10000 / v.grams);
        const pantryErr = await runTool("update_pantry", {
          items: {
            [toSnakeName(v.name)]: {
              quantity: 0,
              unit: "g",
              macros: per100,
              ...(v.barcode ? { barcode: v.barcode } : {}),
            },
          },
          mode: "merge",
        });
        if (pantryErr) {
          setLogError(pantryErr);
          return;
        }
      }
      const error = await runTool("log_meal", {
        date: dateIso,
        slot: v.slot,
        ...(v.time ? { time: v.time } : {}),
        items: [
          {
            food: v.name,
            grams: v.grams,
            kcal: Math.round(v.macros.kcal),
            p: Math.round(v.macros.p * 10) / 10,
            f: Math.round(v.macros.f * 10) / 10,
            c: Math.round(v.macros.c * 10) / 10,
            ...(v.macros.fiber != null ? { fiber: Math.round(v.macros.fiber * 10) / 10 } : {}),
          },
        ],
      });
      if (error) {
        setLogError(error);
        return;
      }
      onLogged();
      onOpenChange(false);
    } catch (e) {
      setLogError(e instanceof Error ? e.message : String(e));
    } finally {
      setLogging(false);
    }
  }

  return (
    <>
      {cameraOpen && (
        <CameraModal
          onClose={() => setCameraOpen(false)}
          onCapture={(blob) => {
            setCameraOpen(false);
            void runScan(
              new File([blob], `food-${Date.now()}.jpg`, {
                type: "image/jpeg",
              }),
            );
          }}
        />
      )}
      {scanCameraOpen && (
        <CameraModal
          scan
          onClose={() => {
            setScanCameraOpen(false);
            setScanForPrefill(false);
          }}
          onDetect={(code) => void (scanForPrefill ? runBarcodePrefill(code) : runBarcode(code))}
          onCapture={(blob) => {
            // "Snap photo instead" — the barcode wouldn't read, so fall back to
            // AI recognition of the label/product (tier 4 of the cascade).
            setScanCameraOpen(false);
            setScanForPrefill(false);
            void runScan(
              new File([blob], `food-${Date.now()}.jpg`, {
                type: "image/jpeg",
              }),
            );
          }}
        />
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void runScan(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="modal-cap flex flex-col gap-3"
          // Keep this dialog open while a fullscreen camera is up — the camera
          // portals to <body>, so a tap in it reads as an outside-interaction
          // here and would otherwise dismiss the whole flow.
          onInteractOutside={(e) => {
            if (cameraOpen || scanCameraOpen) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (cameraOpen || scanCameraOpen) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {customPantry
                ? t("nutrition.add.manualProduct")
                : custom
                  ? t("nutrition.add.customFood")
                  : isPantry
                    ? picked
                      ? t("nutrition.add.addToPantry")
                      : t("nutrition.add.addPantryItem")
                    : picked || pickedRecipe
                      ? t("nutrition.add.logFood")
                      : t("nutrition.add.addFood")}
            </DialogTitle>
            <DialogDescription>
              {customPantry
                ? t("nutrition.add.manualProductDescription")
                : custom
                  ? t("nutrition.add.customDescription", { date: isoToDisplay(dateIso) })
                  : picked || pickedRecipe
                    ? isPantry
                      ? t("nutrition.add.setOnHand")
                      : t("nutrition.add.loggingTo", { date: isoToDisplay(dateIso) })
                    : t("nutrition.add.searchDescription")}
            </DialogDescription>
          </DialogHeader>

          {customPantry ? (
            <CustomPantryStep
              prefill={pantryPrefill}
              saving={logging}
              saveError={logError}
              barcodeLoading={barcodeLoading}
              barcodeError={barcodeError}
              onScanBarcode={() => {
                setBarcodeError(null);
                setScanForPrefill(true);
                setScanCameraOpen(true);
              }}
              onBack={() => {
                setCustomPantry(false);
                setLogError(null);
                setBarcodeError(null);
              }}
              onSave={saveCustomPantry}
            />
          ) : custom ? (
            <CustomFoodStep
              dateIso={dateIso}
              logging={logging}
              logError={logError}
              onBack={() => {
                setCustom(false);
                setLogError(null);
              }}
              onLog={logCustom}
            />
          ) : pickedRecipe ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
                <LogRecipeForm
                  schema={EMPTY_SCHEMA}
                  value={recipeDraft}
                  onChange={(next) => setRecipeDraft(next as Record<string, unknown>)}
                  disabled={logging}
                />
              </div>
              {logError && <p className="text-sm text-destructive">{logError}</p>}
              <div className="flex items-center justify-between gap-2 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPickedRecipe(null);
                    setLogError(null);
                  }}
                  className="gap-1"
                >
                  <ArrowLeft className="size-4" />
                  {t("common.back")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void logRecipe()}
                  disabled={logging || pickedRecipe.unresolved > 0}
                  className="gap-2"
                >
                  {logging && <Loader2 className="size-4 animate-spin" />}
                  {t("nutrition.add.logTo", {
                    date: isoToDisplay(String(recipeDraft.date ?? dateIso)),
                  })}
                </Button>
              </div>
            </div>
          ) : picked ? (
            <ConfirmStep
              picked={picked}
              grams={grams}
              setGrams={setGrams}
              slot={slot}
              setSlot={setSlot}
              time={time}
              setTime={setTime}
              scaled={scaled}
              dateIso={dateIso}
              logging={logging}
              logError={logError}
              isPantry={isPantry}
              pantryUnit={pantryUnit}
              setPantryUnit={setPantryUnit}
              onBack={() => setPicked(null)}
              onLog={isPantry ? addToPantry : logIt}
            />
          ) : (
            <SearchStep
              q={q}
              setQ={setQ}
              barcode={barcode}
              setBarcode={setBarcode}
              db={db}
              foodMatches={foodMatches}
              foodLoading={foodLoading}
              pantryMatches={pantryMatches}
              recipeMatches={recipeMatches}
              off={off}
              offLoading={offLoading}
              offError={offError}
              scan={scan}
              scanLoading={scanLoading}
              scanError={scanError}
              barcodeLoading={barcodeLoading}
              barcodeError={barcodeError}
              isPantry={isPantry}
              onScan={() => runOff({ barcode })}
              onScanBarcode={() => {
                setBarcodeError(null);
                setScanCameraOpen(true);
              }}
              onTakePhoto={() => setCameraOpen(true)}
              onUploadPhoto={() => fileRef.current?.click()}
              onPickDb={pickDb}
              onPickOff={pickOff}
              onPickImage={pickImage}
              onPickRecipe={pickRecipe}
              onEnterCustom={isPantry ? () => setCustomPantry(true) : () => setCustom(true)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function SearchStep({
  q,
  setQ,
  barcode,
  setBarcode,
  db,
  foodMatches,
  foodLoading,
  pantryMatches,
  recipeMatches,
  off,
  offLoading,
  offError,
  scan,
  scanLoading,
  scanError,
  barcodeLoading,
  barcodeError,
  isPantry,
  onScan,
  onScanBarcode,
  onTakePhoto,
  onUploadPhoto,
  onPickDb,
  onPickOff,
  onPickImage,
  onPickRecipe,
  onEnterCustom,
}: {
  q: string;
  setQ: (v: string) => void;
  barcode: string;
  setBarcode: (v: string) => void;
  db: FoodDb;
  foodMatches: string[];
  foodLoading: boolean;
  pantryMatches: string[];
  recipeMatches: RecipeMatch[];
  off: OffSummary[] | null;
  offLoading: boolean;
  offError: string | null;
  scan: RecognizedFood[] | null;
  scanLoading: boolean;
  scanError: string | null;
  barcodeLoading: boolean;
  barcodeError: string | null;
  isPantry: boolean;
  onScan: () => void;
  onScanBarcode: () => void;
  onTakePhoto: () => void;
  onUploadPhoto: () => void;
  onPickDb: (name: string, source: "db" | "pantry") => void;
  onPickOff: (p: OffSummary) => void;
  onPickImage: (f: RecognizedFood) => void;
  onPickRecipe: (r: RecipeMatch) => void;
  // Log mode only: open the free-form custom-food form. Undefined in pantry mode.
  onEnterCustom?: () => void;
}) {
  const { t } = useTranslation();
  const term = q.trim();
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute inset-s-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          value={q}
          placeholder={t("nutrition.add.searchFoodsPlaceholder")}
          onChange={(e) => setQ(e.target.value)}
          className="h-9 ps-8"
        />
      </div>

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {scanLoading && (
          <p className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("nutrition.add.recognizing")}
          </p>
        )}

        {scan != null && scan.length > 0 && (
          <Group label={t("nutrition.add.fromPhoto")} icon={<Camera className="size-3.5" />}>
            {scan.map((f, i) => (
              <Row
                key={`s-${f.food}-${i}`}
                title={f.display_name}
                subtitle={
                  f.per_100g
                    ? f.estimated_grams
                      ? t("nutrition.add.photoSubtitle", {
                          kcal: f.per_100g.kcal,
                          grams: f.estimated_grams,
                          confidence: f.confidence,
                        })
                      : t("nutrition.add.photoSubtitleNoGrams", {
                          kcal: f.per_100g.kcal,
                          confidence: f.confidence,
                        })
                    : t("nutrition.add.macrosUnavailable")
                }
                disabled={!isPantry && !f.per_100g}
                onClick={() => onPickImage(f)}
              />
            ))}
          </Group>
        )}

        {scanError && <p className="px-1 py-2 text-sm text-destructive">{scanError}</p>}

        {recipeMatches.length > 0 && (
          <Group label={t("nutrition.add.recipes")} icon={<ChefHat className="size-3.5" />}>
            {recipeMatches.map((r) => (
              <Row
                key={`r-${r.id}`}
                title={r.name}
                subtitle={
                  r.unresolved > 0
                    ? t("nutrition.add.recipeUnresolved", { count: r.unresolved })
                    : t("nutrition.add.recipeSubtitle", {
                        kcal: Math.round(r.kcal_per_serving),
                        count: r.servings,
                      })
                }
                onClick={() => onPickRecipe(r)}
              />
            ))}
          </Group>
        )}

        {pantryMatches.length > 0 && (
          <Group label={t("nutrition.add.fromPantry")} icon={<Refrigerator className="size-3.5" />}>
            {pantryMatches.map((n) => (
              <Row
                key={`p-${n}`}
                title={humanizeFoodName(n)}
                subtitle={
                  db[n]
                    ? t("nutrition.add.kcalPer100g", { kcal: db[n].kcal })
                    : t("nutrition.add.notInFoodDb")
                }
                onClick={() => onPickDb(n, "pantry")}
              />
            ))}
          </Group>
        )}

        {foodLoading && (
          <p className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("nutrition.add.searchingFoods")}
          </p>
        )}

        {!foodLoading && foodMatches.length > 0 && (
          <Group label={t("nutrition.add.foods")}>
            {foodMatches
              .filter((n) => !pantryMatches.includes(n))
              .map((n) => {
                const cat = db[n]?.category;
                const kcal = db[n]?.kcal ?? "?";
                return (
                  <Row
                    key={`d-${n}`}
                    title={humanizeFoodName(n)}
                    subtitle={
                      cat
                        ? t("nutrition.add.kcalPer100gCategory", {
                            kcal,
                            category: humanizeCategory(cat),
                          })
                        : t("nutrition.add.kcalPer100g", { kcal })
                    }
                    onClick={() => onPickDb(n, "db")}
                  />
                );
              })}
          </Group>
        )}

        {term.length >= 2 &&
          !foodLoading &&
          foodMatches.length === 0 &&
          pantryMatches.length === 0 &&
          recipeMatches.length === 0 && (
            <EmptyState icon={Search} compact>
              {t("nutrition.add.noLocalMatches")}
            </EmptyState>
          )}

        {term.length < 2 && pantryMatches.length === 0 && (
          <p className="px-1 py-2 text-sm text-muted-foreground">
            {t("nutrition.add.typeToSearch")}
          </p>
        )}

        {offLoading && (
          <p className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("nutrition.add.searchingDatabase")}
          </p>
        )}

        {off != null && (
          <Group label={t("nutrition.add.packagedProducts")}>
            {off.map((p, i) => (
              <Row
                key={`o-${p.barcode ?? i}`}
                title={[p.brand, p.name].filter(Boolean).join(" — ") || p.name}
                subtitle={
                  p.per_100g
                    ? p.quantity
                      ? t("nutrition.add.kcalPer100gQuantity", {
                          kcal: p.per_100g.kcal,
                          quantity: p.quantity,
                        })
                      : t("nutrition.add.kcalPer100g", { kcal: p.per_100g.kcal })
                    : t("nutrition.add.macrosUnavailable")
                }
                disabled={!isPantry && !p.per_100g}
                onClick={() => onPickOff(p)}
              />
            ))}
            {off.length === 0 && !offError && (
              <EmptyState icon={PackageSearch} compact>
                {t("nutrition.add.noPackagedMatched")}
              </EmptyState>
            )}
          </Group>
        )}

        {offError && <p className="px-1 py-2 text-sm text-destructive">{offError}</p>}
      </div>

      <div className="space-y-2 border-t pt-3">
        <Button
          type="button"
          size="sm"
          className="w-full gap-2"
          disabled={scanLoading || barcodeLoading}
          onClick={onScanBarcode}
        >
          {barcodeLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ScanBarcode className="size-4" />
          )}
          {t("nutrition.add.scanBarcode")}
        </Button>
        <FeatureLock name="ai_image">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1 gap-2"
              disabled={scanLoading}
              onClick={onTakePhoto}
            >
              <Camera className="size-4" />
              {t("nutrition.add.takePhoto")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1 gap-2"
              disabled={scanLoading}
              onClick={onUploadPhoto}
            >
              <Upload className="size-4" />
              {t("nutrition.add.uploadImage")}
            </Button>
          </div>
        </FeatureLock>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <ScanBarcode className="pointer-events-none absolute inset-s-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={barcode}
              inputMode="numeric"
              placeholder={t("nutrition.add.barcodePlaceholder")}
              onChange={(e) => setBarcode(e.target.value)}
              className="h-9 ps-8"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!barcode.trim() || offLoading}
            onClick={onScan}
          >
            {t("nutrition.add.lookUp")}
          </Button>
        </div>
        {barcodeLoading && (
          <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("nutrition.add.lookingUpBarcode")}
          </p>
        )}
        {barcodeError && <p className="px-1 text-sm text-destructive">{barcodeError}</p>}
        {onEnterCustom && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full gap-2"
            onClick={onEnterCustom}
          >
            <PencilLine className="size-4" />
            {isPantry ? t("nutrition.add.enterManualProduct") : t("nutrition.add.enterCustom")}
          </Button>
        )}
      </div>
    </div>
  );
}

function ConfirmStep({
  picked,
  grams,
  setGrams,
  slot,
  setSlot,
  time,
  setTime,
  scaled,
  dateIso,
  logging,
  logError,
  isPantry,
  pantryUnit,
  setPantryUnit,
  onBack,
  onLog,
}: {
  picked: Picked;
  grams: number;
  setGrams: (v: number) => void;
  slot: string;
  setSlot: (v: string) => void;
  time: string;
  setTime: (v: string) => void;
  scaled: Macros | null;
  dateIso: string;
  logging: boolean;
  logError: string | null;
  isPantry: boolean;
  pantryUnit: "g" | "ml" | "pcs";
  setPantryUnit: (v: "g" | "ml" | "pcs") => void;
  onBack: () => void;
  onLog: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      {/* What + how much: the item, with its grams on the right (log mode). */}
      <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{picked.label}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {picked.source === "openfoodfacts"
              ? t("nutrition.add.sourceOpenFoodFacts")
              : picked.source === "pantry"
                ? t("nutrition.add.sourcePantry")
                : picked.source === "image"
                  ? t("nutrition.add.sourceImage")
                  : t("nutrition.add.sourceYourFoods")}
            {picked.per100
              ? ` ${t("nutrition.add.perServingKcal", { kcal: picked.per100.kcal })}`
              : isPantry
                ? ""
                : ` ${t("nutrition.add.macrosResolvedOnLog")}`}
          </div>
        </div>
        {!isPantry && (
          <>
            <Input
              type="number"
              step="any"
              inputMode="decimal"
              value={Number.isFinite(grams) ? grams : ""}
              onChange={(e) => setGrams(e.target.value === "" ? NaN : Number(e.target.value))}
              className="h-9 w-20 text-end font-semibold tabular-nums"
              aria-label={t("nutrition.add.grams")}
            />
            <span className="text-xs text-muted-foreground">g</span>
          </>
        )}
      </div>

      {/* Where it lands: slot + time (log mode) / quantity + unit (pantry). */}
      <div className={cn("grid gap-2", isPantry ? "grid-cols-2" : "grid-cols-[1fr_6rem]")}>
        {isPantry ? (
          <>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                {t("nutrition.add.quantityOnHand")}
              </Label>
              <Input
                type="number"
                step="any"
                value={Number.isFinite(grams) ? grams : ""}
                onChange={(e) => setGrams(e.target.value === "" ? NaN : Number(e.target.value))}
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("nutrition.add.unit")}</Label>
              <Select
                value={pantryUnit}
                onValueChange={(v) => setPantryUnit(v as "g" | "ml" | "pcs")}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="g">{t("nutrition.add.unitGrams")}</SelectItem>
                  <SelectItem value="ml">{t("nutrition.add.unitMillilitres")}</SelectItem>
                  <SelectItem value="pcs">{t("nutrition.add.unitPieces")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("nutrition.add.slot")}</Label>
              <Select value={slot} onValueChange={setSlot}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEAL_SLOTS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{t("nutrition.add.time")}</Label>
              <TimeInput value={time} onChange={(hhmm) => setTime(hhmm || "")} />
            </div>
          </>
        )}
      </div>

      {!isPantry &&
        // Same live preview as LogRecipeForm: the item (or the day after it) vs target.
        (scaled ? (
          <LogMacroPreview item={scaled} dateIso={dateIso} />
        ) : (
          <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
            {t("nutrition.add.macrosResolvedWhenLogged")}
          </div>
        ))}

      {logError && <p className="text-sm text-destructive">{logError}</p>}

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} className="gap-1">
          <ArrowLeft className="size-4" />
          {t("common.back")}
        </Button>
        <Button type="button" size="sm" onClick={onLog} disabled={logging} className="gap-2">
          {logging && <Loader2 className="size-4 animate-spin" />}
          {isPantry
            ? t("nutrition.add.addToPantry")
            : t("nutrition.add.logTo", { date: isoToDisplay(dateIso) })}
        </Button>
      </div>
    </div>
  );
}

// Free-form meal entry for food that isn't in the pantry (delivery / eating
// out). Macros default to TOTALS for the portion (the natural mental model for
// a restaurant dish or a menu's stated calories); a toggle switches to per-100g
// (a packaged label), scaled by the amount on submit. Either way totals are
// sent to log_meal inline. `amount` is the portion size, used for the record
// and to derive per-100g macros if the user saves the item to their pantry.
function CustomFoodStep({
  dateIso,
  logging,
  logError,
  onBack,
  onLog,
}: {
  dateIso: string;
  logging: boolean;
  logError: string | null;
  onBack: () => void;
  onLog: (v: {
    name: string;
    // Only kept when saved to the pantry (log_meal has no barcode), so a later
    // scan resolves to the saved item.
    barcode: string | null;
    grams: number;
    macros: Macros;
    slot: string;
    time: string;
    saveToPantry: boolean;
  }) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [barcode, setBarcode] = useState<string | null>(null);
  const [macros, setMacros] = useState<MacroValues>({});
  const [basis, setBasis] = useState<"total" | "per100">("total");
  const [grams, setGrams] = useState("100");
  const [slot, setSlot] = useState<string>(defaultSlot());
  const [time, setTime] = useState(nowTime);
  const [saveToPantry, setSaveToPantry] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

  function submit() {
    const trimmedName = name.trim();
    const gramsN = num(grams);
    const scale = (v: number) =>
      basis === "per100" ? Math.round(((v * gramsN) / 100) * 10) / 10 : v;
    const kcalN = macros.kcal;
    if (!trimmedName) {
      setLocalError(t("nutrition.add.nameRequired"));
      return;
    }
    if (kcalN == null || !Number.isFinite(kcalN) || kcalN < 0) {
      setLocalError(t("nutrition.add.caloriesInvalid"));
      return;
    }
    if (!Number.isFinite(gramsN) || gramsN <= 0) {
      setLocalError(t("nutrition.add.amountInvalid"));
      return;
    }
    setLocalError(null);
    // Totals for the portion are sent inline; per-100g entries scale first.
    const macrosOut: Macros = {
      kcal: scale(kcalN),
      p: scale(macros.p ?? 0),
      f: scale(macros.f ?? 0),
      c: scale(macros.c ?? 0),
      ...(macros.fiber != null ? { fiber: scale(macros.fiber) } : {}),
    };
    onLog({
      name: trimmedName,
      barcode: barcode?.trim() || null,
      grams: gramsN,
      macros: macrosOut,
      slot,
      time,
      saveToPantry,
    });
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{t("nutrition.add.name")}</Label>
        <Input
          autoFocus
          value={name}
          placeholder={t("nutrition.add.namePlaceholder")}
          onChange={(e) => setName(e.target.value)}
          className="h-9"
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{t("forms.pantry.barcode")}</Label>
        <BarcodeInput value={barcode} onChange={setBarcode} />
      </div>

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{t("nutrition.add.amountG")}</Label>
        {/* The amount sits beside what the macros below are entered against:
            totals for this amount, or per 100 g (scaled on submit). */}
        <div className="flex items-center gap-2">
          <Input
            type="number"
            step="any"
            inputMode="decimal"
            value={grams}
            onChange={(e) => setGrams(e.target.value)}
            className="h-9 min-w-0 flex-1"
          />
          <div className="flex h-9 shrink-0 rounded-md border p-0.5" role="group">
            {(
              [
                ["total", t("nutrition.add.macrosForAmount")],
                ["per100", t("nutrition.add.macrosPer100g")],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={basis === v}
                onClick={() => setBasis(v)}
                className={cn(
                  "rounded-sm px-2.5 text-xs font-medium whitespace-nowrap transition-colors",
                  basis === v
                    ? "bg-primary/10 text-foreground shadow-pressed soft:bg-transparent soft:text-primary"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Shared macro sub-controls (same as FoodForm / the gate forms). */}
      <MacroFields value={macros} onChange={setMacros} />

      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t("nutrition.add.slot")}</Label>
          <Select value={slot} onValueChange={setSlot}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MEAL_SLOTS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">{t("nutrition.add.time")}</Label>
          <TimeInput value={time} onChange={(hhmm) => setTime(hhmm || "")} />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={saveToPantry}
          onChange={(e) => setSaveToPantry(e.target.checked)}
          className="size-4"
        />
        <span className="text-muted-foreground">{t("nutrition.add.alsoSaveToPantry")}</span>
      </label>
      <p className="text-xs text-muted-foreground">
        {basis === "per100" ? t("nutrition.add.customHintPer100") : t("nutrition.add.customHint")}
      </p>

      {(localError || logError) && (
        <p className="text-sm text-destructive">{localError || logError}</p>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} className="gap-1">
          <ArrowLeft className="size-4" />
          {t("common.back")}
        </Button>
        <Button type="button" size="sm" onClick={submit} disabled={logging} className="gap-2">
          {logging && <Loader2 className="size-4 animate-spin" />}
          {t("nutrition.add.logTo", { date: isoToDisplay(dateIso) })}
        </Button>
      </div>
    </div>
  );
}

// Hand-enter a brand-new product straight into the pantry — the manual path for
// items that aren't in the catalog, OpenFoodFacts, or resolvable by a scan.
// Macros are per-100g (the pantry's storage convention). The "Scan barcode"
// action reuses the on-device scanner: a resolved code prefills name + macros +
// barcode; an unresolved one just fills the barcode so the rest is typed in.
function CustomPantryStep({
  prefill,
  saving,
  saveError,
  barcodeLoading,
  barcodeError,
  onScanBarcode,
  onBack,
  onSave,
}: {
  prefill: { nonce: number; barcode: string; name?: string; macros?: MacroValues } | null;
  saving: boolean;
  saveError: string | null;
  barcodeLoading: boolean;
  barcodeError: string | null;
  onScanBarcode: () => void;
  onBack: () => void;
  onSave: (name: string, fields: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PantryItemDraft>(emptyPantryItemDraft);
  const [localError, setLocalError] = useState<string | null>(null);
  const patch = (p: Partial<PantryItemDraft>) => setDraft((d) => ({ ...d, ...p }));

  // Apply a scanned-barcode result. Keyed on `nonce` so a re-scan of the same
  // code re-fills. Fields the lookup didn't resolve are left as the user has
  // them (a miss only carries the barcode).
  useEffect(() => {
    if (!prefill) return;
    setDraft((d) => ({
      ...d,
      barcode: prefill.barcode,
      ...(prefill.name ? { name: prefill.name } : {}),
      ...(prefill.macros ? { macros: prefill.macros } : {}),
    }));
  }, [prefill]);

  function submit() {
    const trimmed = draft.name.trim();
    if (!trimmed) {
      setLocalError(t("nutrition.add.nameRequired"));
      return;
    }
    if (draft.quantity === "" || !Number.isFinite(draft.quantity) || draft.quantity < 0) {
      setLocalError(t("nutrition.add.quantityInvalid"));
      return;
    }
    setLocalError(null);
    // A new item: leave out the cleared fields (null) instead of sending them,
    // so adding a name that already exists never wipes its facts.
    const fields = Object.fromEntries(
      Object.entries(pantryDraftFields(draft)).filter(([, v]) => v != null),
    );
    onSave(trimmed, fields);
  }

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
      <PantryItemFields
        value={draft}
        onChange={patch}
        disabled={saving}
        autoFocusName
        scan={{ onScan: onScanBarcode, loading: barcodeLoading, error: barcodeError }}
      />

      {(localError || saveError) && (
        <p className="text-sm text-destructive">{localError || saveError}</p>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} className="gap-1">
          <ArrowLeft className="size-4" />
          {t("common.back")}
        </Button>
        <Button type="button" size="sm" onClick={submit} disabled={saving} className="gap-2">
          {saving && <Loader2 className="size-4 animate-spin" />}
          {t("nutrition.add.addToPantry")}
        </Button>
      </div>
    </div>
  );
}

function Group({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2">
      <div className="flex items-center gap-1.5 p-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {icon}
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({
  title,
  subtitle,
  disabled,
  onClick,
}: {
  title: string;
  subtitle?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full flex-col items-start rounded-md px-2 py-1.5 text-start transition-[color,background-color,box-shadow]",
        disabled
          ? "cursor-not-allowed opacity-50"
          : "hover:bg-accent soft:hover:bg-background soft:hover:text-primary soft:hover:shadow-pressed",
      )}
    >
      <span className="w-full text-sm wrap-break-word">{title}</span>
      {subtitle && (
        <span className="w-full text-[11px] wrap-break-word text-muted-foreground">{subtitle}</span>
      )}
    </button>
  );
}
