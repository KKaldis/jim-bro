import { createElement, type ReactNode } from "react";
import { Dumbbell, Flame, HeartPulse, Mars, Scale, Venus, type LucideIcon } from "lucide-react";
import {
  ageFromBirthYear,
  classifyBodyShape,
  computeBmi,
  computeBmrFromInputs,
  computeCalorieDeficit,
  computeFfmi,
  computeHeartRateZones,
  computeIdealProportions,
  computeIdealWeight,
  computeMaxPotential,
  computePotentialProgress,
  computeOneRepMax,
  computePlateRacking,
  computePowerliftingScore,
  computeRpe,
  computeStepCalories,
  computeStrengthStandards,
  computeStrengthSymmetry,
  computeTrainingVolume,
  computeVo2Max,
  computeWarmupSets,
  computeWaterIntake,
  DEFAULT_PLATES_LB,
  estimateBodyFatArmy,
  estimateBodyFatDeurenberg,
  estimateBodyFatNavy,
  estimateResistanceKcal,
  estimateTrainingKcal,
  MET_TABLE,
  type ActivityLevel,
  type Goal,
  type Sex,
} from "@fa/shared";
import type { FormContext } from "../forms/formContext";
import { getResultCard } from "../cards/resultCards";
import { humanize } from "../lib/catalogLabels";
import { categoryOf } from "../lib/toolCategory";
import { TrainingBurnHeadline } from "../lib/trainingBurn";
import { strengthExerciseName } from "./fields";
import type { CalcFieldDef, CalcValues, NumberFieldDef, SegmentedOptionDef } from "./fields";
import { cmFromDisplay, cmToDisplay, kgFromDisplay, kgToDisplay, type Units } from "./units";

// The manual-calculator registry. Each calculator binds three things:
//   fields   — the editable inputs (rendered via CalcFieldControl)
//   prefill  — seeds those inputs from the user's profile + last weigh-in
//   compute  — converts the (display-unit) inputs to metric and calls the shared
//              @fa/shared math, returning the exact object the tool's result card
//              reads (getResultCard(toolName)).
// So a calculator is just: prefilled editable inputs → shared fn → existing card,
// recomputed live on every edit, with no agent round-trip.

export type Calculator = {
  id: string;
  // Drives the result card (getResultCard) + its category theming (categoryOf).
  toolName: string;
  titleKey: string;
  descKey?: string;
  fields: CalcFieldDef[];
  prefill: (ctx: FormContext, units: Units) => CalcValues;
  compute: (v: CalcValues, units: Units) => unknown;
  // Optional bespoke result renderer, for calculators with no existing chat
  // result card to reuse (e.g. resistance burn reuses the TrainingBurnHeadline
  // widget). When set, it replaces getResultCard(toolName) in CalculatorCard.
  renderResult?: (
    data: unknown,
    t: (key: string, opts?: Record<string, unknown>) => string,
    units: Units,
  ) => ReactNode;
};

export type CalcSection = {
  id: string;
  titleKey: string;
  Icon: LucideIcon;
  calculators: Calculator[];
};

// ---- value readers ----
function num(v: CalcValues, k: string): number | undefined {
  const n = v[k];
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}
function str(v: CalcValues, k: string): string | undefined {
  const s = v[k];
  return typeof s === "string" && s ? s : undefined;
}
function sexOf(v: CalcValues): Sex | undefined {
  const s = str(v, "sex");
  return s === "male" || s === "female" ? s : undefined;
}
function ageFromCtx(ctx: FormContext): number | undefined {
  return ctx.profile?.birth_year != null ? ageFromBirthYear(ctx.profile.birth_year) : undefined;
}

// ---- shared option sets (reuse the profile form's existing i18n labels) ----
const SEX_OPTIONS: readonly SegmentedOptionDef[] = [
  { value: "male", labelKey: "formsAdmin.profile.sexMale", Icon: Mars },
  { value: "female", labelKey: "formsAdmin.profile.sexFemale", Icon: Venus },
];
const ACTIVITY_OPTIONS: readonly SegmentedOptionDef[] = [
  { value: "sedentary", labelKey: "formsAdmin.profile.activitySedentary" },
  { value: "light", labelKey: "formsAdmin.profile.activityLight" },
  { value: "moderate", labelKey: "formsAdmin.profile.activityModerate" },
  { value: "very", labelKey: "formsAdmin.profile.activityVery" },
  { value: "extreme", labelKey: "formsAdmin.profile.activityExtreme" },
];
const GOAL_OPTIONS: readonly SegmentedOptionDef[] = [
  { value: "cut", labelKey: "formsAdmin.profile.goalCut" },
  { value: "maintain", labelKey: "formsAdmin.profile.goalMaintain" },
  { value: "recomp", labelKey: "formsAdmin.profile.goalRecomp" },
  { value: "lean_bulk", labelKey: "formsAdmin.profile.goalLeanBulk" },
];
// Planned weekly loss as a % of bodyweight, for the calorie-deficit calculator.
const LOSS_RATE_OPTIONS: readonly SegmentedOptionDef[] = [
  { value: "0.25", labelKey: "calculators.opt.loss025" },
  { value: "0.5", labelKey: "calculators.opt.loss05" },
  { value: "0.75", labelKey: "calculators.opt.loss075" },
  { value: "1", labelKey: "calculators.opt.loss1" },
];

const CLIMATE_OPTIONS: readonly SegmentedOptionDef[] = [
  { value: "temperate", labelKey: "calculators.opt.temperate" },
  { value: "hot", labelKey: "calculators.opt.hot" },
];
const PACE_OPTIONS: readonly SegmentedOptionDef[] = [
  { value: "slow", labelKey: "calculators.opt.paceSlow" },
  { value: "brisk", labelKey: "calculators.opt.paceBrisk" },
];

// snake_case MET key → "Running Easy" for the activity picker.
const ACTIVITY_MET_OPTIONS = Object.keys(MET_TABLE).map((k) => ({ value: k, label: humanize(k) }));

// Seed a weight field (kg stored) into display units from the last weigh-in.
function weightSeed(ctx: FormContext, units: Units): number | undefined {
  const kg = ctx.lastBodyComp?.weight_kg;
  return kg != null ? kgToDisplay(kg, units) : undefined;
}
function heightSeed(ctx: FormContext, units: Units): number | undefined {
  const cm = ctx.profile?.height_cm;
  return cm != null ? cmToDisplay(cm, units) : undefined;
}

// Seed a length field from a stored metric value (profile or last weigh-in).
function lengthSeed(cm: number | null | undefined, units: Units): number | undefined {
  return cm != null ? cmToDisplay(cm, units) : undefined;
}
// A length field in display units → cm, or undefined when blank.
function cmOf(v: CalcValues, k: string, units: Units): number | undefined {
  const n = num(v, k);
  return n != null ? cmFromDisplay(n, units) : undefined;
}
// Optional tape girth field (blank = not measured).
function girthField(
  id: string,
  labelKey: string,
  extra: Partial<Omit<NumberFieldDef, "kind" | "id" | "labelKey">> = {},
): NumberFieldDef {
  return { id, kind: "number", unit: "length", labelKey, optional: true, ...extra };
}
const isMale = (v: CalcValues) => sexOf(v) === "male";
const isFemale = (v: CalcValues) => sexOf(v) === "female";

export const CALCULATOR_SECTIONS: CalcSection[] = [
  // ============================== BODY COMPOSITION ==============================
  {
    id: "body",
    titleKey: "calculators.sections.body",
    Icon: Scale,
    calculators: [
      {
        id: "bmi",
        toolName: "compute_bmi",
        titleKey: "calculators.bmi.title",
        descKey: "calculators.bmi.desc",
        fields: [
          { id: "weight", kind: "number", unit: "weight", labelKey: "calculators.fields.weight" },
          { id: "height", kind: "number", unit: "length", labelKey: "calculators.fields.height" },
        ],
        prefill: (ctx, units) => ({
          weight: weightSeed(ctx, units),
          height: heightSeed(ctx, units),
        }),
        compute: (v, units) => {
          const w = num(v, "weight");
          const h = num(v, "height");
          if (w == null || h == null) return null;
          return computeBmi({
            weight_kg: kgFromDisplay(w, units),
            height_cm: cmFromDisplay(h, units),
          });
        },
      },
      {
        id: "ideal_weight",
        toolName: "compute_ideal_weight",
        titleKey: "calculators.idealWeight.title",
        descKey: "calculators.idealWeight.desc",
        fields: [
          {
            id: "sex",
            kind: "segmented",
            labelKey: "calculators.fields.sex",
            options: SEX_OPTIONS,
          },
          { id: "height", kind: "number", unit: "length", labelKey: "calculators.fields.height" },
        ],
        prefill: (ctx, units) => ({
          sex: ctx.profile?.sex ?? undefined,
          height: heightSeed(ctx, units),
        }),
        compute: (v, units) => {
          const sex = sexOf(v);
          const h = num(v, "height");
          if (!sex || h == null) return null;
          return { ...computeIdealWeight({ sex, height_cm: cmFromDisplay(h, units) }), units };
        },
      },
      {
        id: "body_fat",
        toolName: "estimate_body_fat",
        titleKey: "calculators.bodyFat.title",
        descKey: "calculators.bodyFat.desc",
        fields: [
          {
            id: "method",
            kind: "segmented",
            full: true,
            labelKey: "calculators.fields.method",
            options: [
              { value: "navy", labelKey: "calculators.opt.navy" },
              { value: "deurenberg", labelKey: "calculators.opt.deurenberg" },
              { value: "army", labelKey: "calculators.opt.army" },
            ],
          },
          {
            id: "sex",
            kind: "segmented",
            labelKey: "calculators.fields.sex",
            options: SEX_OPTIONS,
          },
          {
            id: "height",
            kind: "number",
            unit: "length",
            labelKey: "calculators.fields.height",
            visible: (v) => str(v, "method") !== "army",
          },
          {
            id: "neck",
            kind: "number",
            unit: "length",
            labelKey: "calculators.fields.neck",
            infoKey: "calculators.info.neck",
            visible: (v) => (str(v, "method") ?? "navy") === "navy",
          },
          {
            id: "waist",
            kind: "number",
            unit: "length",
            labelKey: "calculators.fields.waist",
            infoKey: "calculators.info.waistNavy",
            visible: (v) => (str(v, "method") ?? "navy") === "navy",
          },
          {
            id: "hip",
            kind: "number",
            unit: "length",
            labelKey: "calculators.fields.hip",
            infoKey: "calculators.info.hip",
            visible: (v) => (str(v, "method") ?? "navy") === "navy" && sexOf(v) === "female",
          },
          // The Army one-site tape is taken at the navel for everyone, so it gets
          // its own field and help text rather than sharing the Navy waist.
          {
            id: "abdomen",
            kind: "number",
            unit: "length",
            labelKey: "calculators.fields.abdomen",
            infoKey: "calculators.info.abdomenArmy",
            visible: (v) => str(v, "method") === "army",
          },
          {
            id: "weight",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.weight",
            visible: (v) => str(v, "method") === "deurenberg" || str(v, "method") === "army",
          },
          {
            id: "age",
            kind: "number",
            unit: "years",
            labelKey: "calculators.fields.age",
            visible: (v) => str(v, "method") === "deurenberg",
          },
        ],
        prefill: (ctx, units) => ({
          method: "navy",
          sex: ctx.profile?.sex ?? undefined,
          height: heightSeed(ctx, units),
          weight: weightSeed(ctx, units),
          age: ageFromCtx(ctx),
          neck: lengthSeed(ctx.lastBodyComp?.neck_cm, units),
          waist: lengthSeed(ctx.lastBodyComp?.waist_cm, units),
          abdomen: lengthSeed(ctx.lastBodyComp?.waist_cm, units),
          hip: lengthSeed(ctx.lastBodyComp?.hip_cm, units),
        }),
        compute: (v, units) => {
          const sex = sexOf(v);
          if (!sex) return null;
          const method = str(v, "method") ?? "navy";
          if (method === "army") {
            const w = num(v, "weight");
            const abdomen = num(v, "abdomen");
            if (w == null || abdomen == null) return null;
            return estimateBodyFatArmy({
              sex,
              weight_kg: kgFromDisplay(w, units),
              waist_cm: cmFromDisplay(abdomen, units),
            });
          }
          if (method === "deurenberg") {
            const w = num(v, "weight");
            const h = num(v, "height");
            const age = num(v, "age");
            if (w == null || h == null || age == null) return null;
            return estimateBodyFatDeurenberg({
              sex,
              weight_kg: kgFromDisplay(w, units),
              height_cm: cmFromDisplay(h, units),
              age,
            });
          }
          const h = num(v, "height");
          const neck = num(v, "neck");
          const waist = num(v, "waist");
          const hip = num(v, "hip");
          if (h == null || neck == null || waist == null) return null;
          if (sex === "female" && hip == null) return null;
          return estimateBodyFatNavy({
            sex,
            height_cm: cmFromDisplay(h, units),
            neck_cm: cmFromDisplay(neck, units),
            waist_cm: cmFromDisplay(waist, units),
            hip_cm: hip != null ? cmFromDisplay(hip, units) : null,
          });
        },
      },
      {
        id: "ffmi",
        toolName: "compute_ffmi",
        titleKey: "calculators.ffmi.title",
        descKey: "calculators.ffmi.desc",
        fields: [
          {
            id: "sex",
            kind: "segmented",
            labelKey: "calculators.fields.sex",
            options: SEX_OPTIONS,
          },
          { id: "weight", kind: "number", unit: "weight", labelKey: "calculators.fields.weight" },
          { id: "height", kind: "number", unit: "length", labelKey: "calculators.fields.height" },
          { id: "bodyFat", kind: "number", unit: "pct", labelKey: "calculators.fields.bodyFat" },
        ],
        prefill: (ctx, units) => ({
          sex: ctx.profile?.sex ?? undefined,
          weight: weightSeed(ctx, units),
          height: heightSeed(ctx, units),
        }),
        compute: (v, units) => {
          const sex = sexOf(v);
          const w = num(v, "weight");
          const h = num(v, "height");
          const bf = num(v, "bodyFat");
          if (!sex || w == null || h == null || bf == null) return null;
          return computeFfmi({
            sex,
            weight_kg: kgFromDisplay(w, units),
            height_cm: cmFromDisplay(h, units),
            body_fat_pct: bf,
          });
        },
      },
      {
        id: "max_potential",
        toolName: "compute_max_potential",
        titleKey: "calculators.maxPotential.title",
        descKey: "calculators.maxPotential.desc",
        fields: [
          {
            id: "sex",
            kind: "segmented",
            labelKey: "calculators.fields.sex",
            options: SEX_OPTIONS,
          },
          { id: "height", kind: "number", unit: "length", labelKey: "calculators.fields.height" },
          {
            id: "wrist",
            kind: "number",
            unit: "length",
            labelKey: "calculators.fields.wrist",
            infoKey: "calculators.info.wrist",
          },
          {
            id: "ankle",
            kind: "number",
            unit: "length",
            labelKey: "calculators.fields.ankle",
            infoKey: "calculators.info.ankle",
          },
          // Current state, for the "how close are you" gauge. Optional — the
          // ceiling itself needs only the frame.
          {
            id: "weight",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.currentWeight",
            optional: true,
            infoKey: "calculators.info.potentialCurrent",
          },
          {
            id: "bodyFat",
            kind: "number",
            unit: "pct",
            labelKey: "calculators.fields.currentBodyFat",
            optional: true,
            infoKey: "calculators.info.potentialCurrent",
          },
          {
            id: "targetBf",
            kind: "number",
            unit: "pct",
            labelKey: "calculators.fields.targetBodyFat",
            optional: true,
          },
        ],
        prefill: (ctx, units) => ({
          sex: ctx.profile?.sex ?? undefined,
          height: heightSeed(ctx, units),
          wrist: lengthSeed(ctx.profile?.wrist_cm, units),
          ankle: lengthSeed(ctx.profile?.ankle_cm, units),
          weight: weightSeed(ctx, units),
          bodyFat: ctx.lastBodyComp?.body_fat_pct ?? undefined,
        }),
        compute: (v, units) => {
          const sex = sexOf(v);
          const h = num(v, "height");
          const wrist = num(v, "wrist");
          const ankle = num(v, "ankle");
          const targetBf = num(v, "targetBf");
          if (!sex || h == null || wrist == null || ankle == null) return null;
          const result = computeMaxPotential({
            sex,
            height_cm: cmFromDisplay(h, units),
            wrist_cm: cmFromDisplay(wrist, units),
            ankle_cm: cmFromDisplay(ankle, units),
            target_body_fat_pct: targetBf,
          });
          const w = num(v, "weight");
          const bf = num(v, "bodyFat");
          const progress =
            w != null && bf != null
              ? computePotentialProgress(result.max_lean_body_mass_kg, kgFromDisplay(w, units), bf)
              : null;
          return { ...result, ...(progress ?? {}) };
        },
      },
      {
        id: "ideal_proportions",
        toolName: "compute_ideal_proportions",
        titleKey: "calculators.idealProportions.title",
        descKey: "calculators.idealProportions.desc",
        fields: [
          {
            id: "sex",
            kind: "segmented",
            labelKey: "calculators.fields.sex",
            options: SEX_OPTIONS,
          },
          {
            id: "wrist",
            kind: "number",
            unit: "length",
            labelKey: "calculators.fields.wrist",
            infoKey: "calculators.info.wrist",
          },
          girthField("shoulders", "calculators.fields.shoulders", {
            infoKey: "calculators.info.shoulders",
          }),
          girthField("chest", "calculators.fields.chestOrBust", {
            infoKey: "calculators.info.chest",
          }),
          girthField("waist", "calculators.fields.waist", {
            infoKey: "calculators.info.waistNarrowest",
          }),
          girthField("hips", "calculators.fields.hip", { infoKey: "calculators.info.hip" }),
          girthField("arm", "calculators.fields.armFlexed", {
            infoKey: "calculators.info.armFlexed",
          }),
          girthField("forearm", "calculators.fields.forearm", {
            infoKey: "calculators.info.forearm",
          }),
          girthField("neck", "calculators.fields.neck", { infoKey: "calculators.info.neck" }),
          girthField("thigh", "calculators.fields.thigh", { infoKey: "calculators.info.thigh" }),
          girthField("calf", "calculators.fields.calf", { infoKey: "calculators.info.calf" }),
          girthField("height", "calculators.fields.height", { infoKey: "calculators.info.height" }),
        ],
        prefill: (ctx, units) => ({
          sex: ctx.profile?.sex ?? undefined,
          wrist: lengthSeed(ctx.profile?.wrist_cm, units),
          height: heightSeed(ctx, units),
          waist: lengthSeed(ctx.lastBodyComp?.waist_cm, units),
          neck: lengthSeed(ctx.lastBodyComp?.neck_cm, units),
          hips: lengthSeed(ctx.lastBodyComp?.hip_cm, units),
        }),
        compute: (v, units) => {
          const sex = sexOf(v);
          const wrist = cmOf(v, "wrist", units);
          if (!sex || wrist == null) return null;
          const parts = [
            "shoulders",
            "chest",
            "waist",
            "hips",
            "arm",
            "forearm",
            "neck",
            "thigh",
            "calf",
          ] as const;
          const measurements = Object.fromEntries(parts.map((p) => [p, cmOf(v, p, units)]));
          return {
            ...computeIdealProportions({
              sex,
              wrist_cm: wrist,
              height_cm: cmOf(v, "height", units),
              measurements,
            }),
            units,
          };
        },
      },
      {
        id: "body_shape",
        toolName: "classify_body_shape",
        titleKey: "calculators.bodyShape.title",
        descKey: "calculators.bodyShape.desc",
        fields: [
          {
            id: "sex",
            kind: "segmented",
            labelKey: "calculators.fields.sex",
            options: SEX_OPTIONS,
          },
          girthField("bust", "calculators.fields.bust", {
            visible: isFemale,
            optional: false,
            infoKey: "calculators.info.bust",
          }),
          girthField("chest", "calculators.fields.chest", {
            visible: isMale,
            optional: false,
            infoKey: "calculators.info.chest",
          }),
          girthField("waist", "calculators.fields.waist", {
            infoKey: "calculators.info.waistNarrowest",
            optional: false,
          }),
          girthField("highHip", "calculators.fields.highHip", {
            visible: isFemale,
            infoKey: "calculators.info.highHip",
          }),
          girthField("hips", "calculators.fields.hip", {
            optional: false,
            infoKey: "calculators.info.hip",
          }),
          girthField("shoulders", "calculators.fields.shoulders", {
            visible: isMale,
            infoKey: "calculators.info.shoulders",
          }),
        ],
        prefill: (ctx, units) => ({
          sex: ctx.profile?.sex ?? undefined,
          waist: lengthSeed(ctx.lastBodyComp?.waist_cm, units),
          hips: lengthSeed(ctx.lastBodyComp?.hip_cm, units),
        }),
        compute: (v, units) => {
          const sex = sexOf(v);
          const waist = cmOf(v, "waist", units);
          const hips = cmOf(v, "hips", units);
          if (!sex || waist == null || hips == null) return null;
          if (sex === "female" && num(v, "bust") == null) return null;
          if (sex === "male" && num(v, "chest") == null) return null;
          return classifyBodyShape({
            sex,
            waist_cm: waist,
            hips_cm: hips,
            bust_cm: sex === "female" ? cmOf(v, "bust", units) : null,
            high_hip_cm: sex === "female" ? cmOf(v, "highHip", units) : null,
            chest_cm: sex === "male" ? cmOf(v, "chest", units) : null,
            shoulders_cm: sex === "male" ? cmOf(v, "shoulders", units) : null,
          });
        },
      },
    ],
  },
  // ================================ ENERGY =====================================
  {
    id: "energy",
    titleKey: "calculators.sections.energy",
    Icon: Flame,
    calculators: [
      {
        id: "bmr",
        toolName: "compute_bmr",
        titleKey: "calculators.bmr.title",
        descKey: "calculators.bmr.desc",
        fields: [
          {
            id: "sex",
            kind: "segmented",
            labelKey: "calculators.fields.sex",
            options: SEX_OPTIONS,
          },
          { id: "weight", kind: "number", unit: "weight", labelKey: "calculators.fields.weight" },
          { id: "height", kind: "number", unit: "length", labelKey: "calculators.fields.height" },
          { id: "age", kind: "number", unit: "years", labelKey: "calculators.fields.age" },
          {
            id: "bodyFat",
            kind: "number",
            unit: "pct",
            labelKey: "calculators.fields.bodyFat",
            optional: true,
            infoKey: "calculators.info.bmrBodyFat",
          },
          {
            id: "activity",
            kind: "segmented",
            full: true,
            cols: 5,
            labelKey: "calculators.fields.activity",
            options: ACTIVITY_OPTIONS,
          },
          {
            id: "goal",
            kind: "segmented",
            full: true,
            cols: 4,
            labelKey: "calculators.fields.goal",
            options: GOAL_OPTIONS,
          },
        ],
        prefill: (ctx, units) => ({
          sex: ctx.profile?.sex ?? undefined,
          weight: weightSeed(ctx, units),
          height: heightSeed(ctx, units),
          age: ageFromCtx(ctx),
          activity: ctx.profile?.activity_level ?? undefined,
          goal: ctx.profile?.goal ?? undefined,
        }),
        compute: (v, units) => {
          const sex = sexOf(v);
          const w = num(v, "weight");
          const h = num(v, "height");
          const age = num(v, "age");
          if (!sex || w == null || h == null || age == null) return null;
          const bf = num(v, "bodyFat");
          const activity = str(v, "activity") as ActivityLevel | undefined;
          const goal = str(v, "goal") as Goal | undefined;
          return computeBmrFromInputs({
            sex,
            weight_kg: kgFromDisplay(w, units),
            height_cm: cmFromDisplay(h, units),
            age,
            body_fat_pct: bf ?? null,
            activity_level: activity,
            goal,
          });
        },
      },
      {
        id: "calorie_deficit",
        toolName: "compute_calorie_deficit",
        titleKey: "calculators.calorieDeficit.title",
        descKey: "calculators.calorieDeficit.desc",
        fields: [
          {
            id: "sex",
            kind: "segmented",
            labelKey: "calculators.fields.sex",
            options: SEX_OPTIONS,
          },
          {
            id: "weight",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.currentWeight",
          },
          { id: "height", kind: "number", unit: "length", labelKey: "calculators.fields.height" },
          { id: "age", kind: "number", unit: "years", labelKey: "calculators.fields.age" },
          {
            id: "bodyFat",
            kind: "number",
            unit: "pct",
            labelKey: "calculators.fields.bodyFat",
            optional: true,
            infoKey: "calculators.info.bmrBodyFat",
          },
          {
            id: "goalWeight",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.goalWeight",
          },
          {
            id: "activity",
            kind: "segmented",
            full: true,
            cols: 5,
            labelKey: "calculators.fields.activity",
            options: ACTIVITY_OPTIONS,
          },
          {
            id: "rate",
            kind: "segmented",
            full: true,
            cols: 4,
            labelKey: "calculators.fields.lossRate",
            infoKey: "calculators.info.lossRate",
            options: LOSS_RATE_OPTIONS,
          },
        ],
        prefill: (ctx, units) => ({
          sex: ctx.profile?.sex ?? undefined,
          weight: weightSeed(ctx, units),
          height: heightSeed(ctx, units),
          age: ageFromCtx(ctx),
          activity: ctx.profile?.activity_level ?? undefined,
          goalWeight:
            ctx.profile?.target_weight_kg != null
              ? kgToDisplay(ctx.profile.target_weight_kg, units)
              : undefined,
          rate: "0.5",
        }),
        compute: (v, units) => {
          const sex = sexOf(v);
          const w = num(v, "weight");
          const h = num(v, "height");
          const age = num(v, "age");
          const goal = num(v, "goalWeight");
          const rate = Number(str(v, "rate") ?? "0.5");
          if (!sex || w == null || h == null || age == null || goal == null) return null;
          return {
            ...computeCalorieDeficit({
              sex,
              weight_kg: kgFromDisplay(w, units),
              height_cm: cmFromDisplay(h, units),
              age,
              body_fat_pct: num(v, "bodyFat") ?? null,
              activity_level: (str(v, "activity") ?? "moderate") as ActivityLevel,
              goal_weight_kg: kgFromDisplay(goal, units),
              weekly_loss_pct: rate,
            }),
            units,
          };
        },
      },
      {
        id: "water_intake",
        toolName: "compute_water_intake",
        titleKey: "calculators.waterIntake.title",
        descKey: "calculators.waterIntake.desc",
        fields: [
          { id: "weight", kind: "number", unit: "weight", labelKey: "calculators.fields.weight" },
          {
            id: "exercise",
            kind: "number",
            unit: "min",
            labelKey: "calculators.fields.exerciseMin",
            min: 0,
            step: 5,
            optional: true,
          },
          {
            id: "sex",
            kind: "segmented",
            labelKey: "calculators.fields.sex",
            options: SEX_OPTIONS,
          },
          {
            id: "climate",
            kind: "segmented",
            full: true,
            cols: 2,
            labelKey: "calculators.fields.climate",
            options: CLIMATE_OPTIONS,
          },
        ],
        prefill: (ctx, units) => ({
          weight: weightSeed(ctx, units),
          sex: ctx.profile?.sex ?? undefined,
          climate: "temperate",
        }),
        compute: (v, units) => {
          const w = num(v, "weight");
          if (w == null) return null;
          return {
            ...computeWaterIntake({
              weight_kg: kgFromDisplay(w, units),
              exercise_min: num(v, "exercise") ?? null,
              climate: str(v, "climate") === "hot" ? "hot" : "temperate",
              sex: sexOf(v) ?? null,
            }),
            units,
          };
        },
      },
    ],
  },
  // ================================ STRENGTH ===================================
  {
    id: "strength",
    titleKey: "calculators.sections.strength",
    Icon: Dumbbell,
    calculators: [
      {
        id: "one_rep_max",
        toolName: "compute_one_rep_max",
        titleKey: "calculators.oneRepMax.title",
        descKey: "calculators.oneRepMax.desc",
        fields: [
          {
            id: "exercise",
            kind: "exercise",
            full: true,
            labelKey: "calculators.fields.exerciseOptional",
            infoKey: "calculators.info.oneRepMaxExercise",
          },
          {
            id: "weight",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.liftWeight",
          },
          {
            id: "reps",
            kind: "number",
            unit: "reps",
            labelKey: "calculators.fields.reps",
            min: 1,
            max: 20,
            step: 1,
          },
          {
            id: "formula",
            kind: "segmented",
            full: true,
            cols: 3,
            labelKey: "calculators.fields.formula",
            options: [
              { value: "epley", labelKey: "calculators.opt.epley" },
              { value: "brzycki", labelKey: "calculators.opt.brzycki" },
              { value: "average", labelKey: "calculators.opt.average" },
            ],
          },
        ],
        prefill: () => ({ formula: "epley", exercise: "bench-press" }),
        compute: (v, units) => {
          const w = num(v, "weight");
          const reps = num(v, "reps");
          if (w == null || reps == null) return null;
          const formula = str(v, "formula");
          const result = computeOneRepMax({
            weight_kg: kgFromDisplay(w, units),
            reps,
            formula: formula === "brzycki" || formula === "average" ? formula : "epley",
          });
          // The 1RM math is exercise-independent; the picked exercise is only a
          // label so the card names the lift being estimated (compute_one_rep_max
          // from chat never sets this — the card reads it defensively).
          const exName = strengthExerciseName(str(v, "exercise"));
          return exName ? { ...result, exercise_name: exName } : result;
        },
      },
      {
        id: "rpe",
        toolName: "convert_rpe",
        titleKey: "calculators.rpe.title",
        descKey: "calculators.rpe.desc",
        fields: [
          {
            id: "weight",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.liftWeight",
          },
          {
            id: "reps",
            kind: "number",
            unit: "reps",
            labelKey: "calculators.fields.reps",
            min: 1,
            max: 12,
            step: 1,
          },
          {
            id: "rpe",
            kind: "number",
            labelKey: "calculators.fields.rpe",
            min: 6,
            max: 10,
            step: 0.5,
            infoKey: "calculators.info.rpe",
          },
          {
            id: "targetReps",
            kind: "number",
            unit: "reps",
            labelKey: "calculators.fields.targetReps",
            min: 1,
            max: 12,
            step: 1,
          },
          {
            id: "targetRpe",
            kind: "number",
            labelKey: "calculators.fields.targetRpe",
            min: 6,
            max: 10,
            step: 0.5,
          },
        ],
        prefill: () => ({ rpe: 8, targetReps: 1, targetRpe: 8 }),
        compute: (v, units) => {
          const w = num(v, "weight");
          const reps = num(v, "reps");
          const rpe = num(v, "rpe");
          if (w == null || reps == null || rpe == null) return null;
          return {
            ...computeRpe({
              weight_kg: kgFromDisplay(w, units),
              reps,
              rpe,
              target_reps: num(v, "targetReps"),
              target_rpe: num(v, "targetRpe"),
            }),
            units,
          };
        },
      },
      {
        id: "strength_level",
        toolName: "assess_strength_level",
        titleKey: "calculators.strengthLevel.title",
        descKey: "calculators.strengthLevel.desc",
        fields: [
          { id: "exercise", kind: "exercise", full: true, labelKey: "calculators.fields.exercise" },
          {
            id: "sex",
            kind: "segmented",
            labelKey: "calculators.fields.sex",
            options: SEX_OPTIONS,
          },
          {
            id: "bodyweight",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.bodyweight",
          },
          {
            id: "oneRepMax",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.oneRepMax",
            optional: true,
            infoKey: "calculators.info.strengthPerf",
          },
          {
            id: "bestWeight",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.bestSetWeight",
            optional: true,
          },
          {
            id: "bestReps",
            kind: "number",
            unit: "reps",
            labelKey: "calculators.fields.bestSetReps",
            optional: true,
            min: 1,
            step: 1,
          },
          {
            id: "age",
            kind: "number",
            unit: "years",
            labelKey: "calculators.fields.age",
            optional: true,
          },
        ],
        prefill: (ctx, units) => ({
          exercise: "bench-press",
          sex: ctx.profile?.sex ?? undefined,
          bodyweight: weightSeed(ctx, units),
          age: ageFromCtx(ctx),
        }),
        compute: (v, units) => {
          const exercise = str(v, "exercise");
          const sex = sexOf(v);
          const bw = num(v, "bodyweight");
          if (!exercise || !sex || bw == null) return null;
          const orm = num(v, "oneRepMax");
          const bestWeight = num(v, "bestWeight");
          const reps = num(v, "bestReps");
          const age = num(v, "age");
          return computeStrengthStandards({
            exercise,
            sex,
            bodyweight_kg: kgFromDisplay(bw, units),
            one_rep_max_kg: orm != null ? kgFromDisplay(orm, units) : undefined,
            weight_kg: bestWeight != null ? kgFromDisplay(bestWeight, units) : undefined,
            reps,
            age,
          });
        },
      },
      {
        id: "powerlifting",
        toolName: "compute_powerlifting_score",
        titleKey: "calculators.powerlifting.title",
        descKey: "calculators.powerlifting.desc",
        fields: [
          {
            id: "sex",
            kind: "segmented",
            labelKey: "calculators.fields.sex",
            options: SEX_OPTIONS,
          },
          {
            id: "bodyweight",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.bodyweight",
          },
          {
            id: "squat",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.squat",
            optional: true,
          },
          {
            id: "bench",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.bench",
            optional: true,
          },
          {
            id: "deadlift",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.deadlift",
            optional: true,
          },
          {
            id: "equipment",
            kind: "segmented",
            full: true,
            labelKey: "calculators.fields.equipment",
            options: [
              { value: "raw", labelKey: "calculators.opt.raw" },
              { value: "equipped", labelKey: "calculators.opt.equipped" },
            ],
          },
        ],
        prefill: (ctx, units) => ({
          sex: ctx.profile?.sex ?? undefined,
          bodyweight: weightSeed(ctx, units),
          equipment: "raw",
        }),
        compute: (v, units) => {
          const sex = sexOf(v);
          const bw = num(v, "bodyweight");
          if (!sex || bw == null) return null;
          const squat = num(v, "squat");
          const bench = num(v, "bench");
          const deadlift = num(v, "deadlift");
          if (squat == null && bench == null && deadlift == null) return null;
          const equipment = str(v, "equipment") === "equipped" ? "equipped" : "raw";
          return computePowerliftingScore({
            sex,
            bodyweight_kg: kgFromDisplay(bw, units),
            squat_kg: squat != null ? kgFromDisplay(squat, units) : undefined,
            bench_kg: bench != null ? kgFromDisplay(bench, units) : undefined,
            deadlift_kg: deadlift != null ? kgFromDisplay(deadlift, units) : undefined,
            equipment,
          });
        },
      },
      {
        id: "symmetry",
        toolName: "strength_symmetry",
        titleKey: "calculators.symmetry.title",
        descKey: "calculators.symmetry.desc",
        fields: [
          {
            id: "sex",
            kind: "segmented",
            labelKey: "calculators.fields.sex",
            options: SEX_OPTIONS,
          },
          {
            id: "bodyweight",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.bodyweight",
          },
          {
            id: "age",
            kind: "number",
            unit: "years",
            labelKey: "calculators.fields.age",
            optional: true,
          },
          { id: "ex1", kind: "exercise", full: true, labelKey: "calculators.fields.lift1" },
          { id: "orm1", kind: "number", unit: "weight", labelKey: "calculators.fields.oneRepMax" },
          { id: "ex2", kind: "exercise", full: true, labelKey: "calculators.fields.lift2" },
          { id: "orm2", kind: "number", unit: "weight", labelKey: "calculators.fields.oneRepMax" },
          { id: "ex3", kind: "exercise", full: true, labelKey: "calculators.fields.lift3" },
          {
            id: "orm3",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.oneRepMax",
            optional: true,
          },
        ],
        prefill: (ctx, units) => ({
          sex: ctx.profile?.sex ?? undefined,
          bodyweight: weightSeed(ctx, units),
          age: ageFromCtx(ctx),
          ex1: "squat",
          ex2: "bench-press",
          ex3: "deadlift",
        }),
        compute: (v, units) => {
          const sex = sexOf(v);
          const bw = num(v, "bodyweight");
          if (!sex || bw == null) return null;
          const age = num(v, "age");
          const pairs = [1, 2, 3]
            .map((i) => {
              const ex = str(v, `ex${i}`);
              const orm = num(v, `orm${i}`);
              return ex && orm != null ? ([ex, orm] as [string, number]) : null;
            })
            .filter((x): x is [string, number] => x != null);
          if (pairs.length < 2) return null;
          return computeStrengthSymmetry({
            sex,
            bodyweight_kg: kgFromDisplay(bw, units),
            age,
            lifts: pairs.map(([exercise, orm]) => ({
              exercise,
              one_rep_max_kg: kgFromDisplay(orm, units),
            })),
          });
        },
      },
      {
        id: "plate_racking",
        toolName: "plate_barbell_racking",
        titleKey: "calculators.plateRacking.title",
        descKey: "calculators.plateRacking.desc",
        fields: [
          {
            id: "target",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.targetWeight",
          },
          {
            id: "bar",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.barWeight",
            optional: true,
          },
        ],
        // Plate racking is unit-agnostic: no default seed, the field placeholder
        // shows the default bar (20 kg / 45 lb).
        prefill: () => ({}),
        compute: (v, units) => {
          // Plate math works directly in the display unit — no metric conversion.
          const target = num(v, "target");
          if (target == null) return null;
          const isImp = units === "imperial";
          const unit = isImp ? "lb" : "kg";
          const bar = num(v, "bar") ?? (isImp ? 45 : 20);
          const plates = isImp ? DEFAULT_PLATES_LB : undefined;
          const r = computePlateRacking(
            { target_kg: target, bar_kg: bar, available_plates_kg: plates },
            unit,
          );
          return {
            unit,
            target: r.target_kg,
            bar: r.bar_kg,
            per_side: r.per_side.map((p) => ({ plate: p.plate_kg, count: p.count })),
            loaded: r.loaded_kg,
            exact: r.exact,
            leftover: r.leftover_kg,
            notes: r.notes,
          };
        },
      },
      {
        id: "warmup",
        toolName: "plan_warmup_sets",
        titleKey: "calculators.warmup.title",
        descKey: "calculators.warmup.desc",
        fields: [
          {
            id: "top",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.topSetWeight",
          },
          {
            id: "topReps",
            kind: "number",
            unit: "reps",
            labelKey: "calculators.fields.topSetReps",
            min: 1,
            step: 1,
          },
          {
            id: "bar",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.barWeight",
            optional: true,
          },
        ],
        prefill: () => ({ topReps: 5 }),
        compute: (v, units) => {
          // Like plate racking, the ramp works in the display unit directly.
          const top = num(v, "top");
          if (top == null) return null;
          return computeWarmupSets({
            top_kg: top,
            top_reps: num(v, "topReps"),
            bar_kg: num(v, "bar"),
            unit: units === "imperial" ? "lb" : "kg",
          });
        },
      },
      {
        id: "training_volume",
        toolName: "compute_training_volume",
        titleKey: "calculators.trainingVolume.title",
        descKey: "calculators.trainingVolume.desc",
        fields: [
          {
            id: "vex1",
            kind: "catalogExercise",
            full: true,
            labelKey: "calculators.fields.exercise1",
          },
          {
            id: "vsets1",
            kind: "number",
            labelKey: "calculators.fields.setsCount",
            min: 1,
            step: 1,
          },
          {
            id: "vreps1",
            kind: "number",
            unit: "reps",
            labelKey: "calculators.fields.repsPerSet",
            min: 1,
            step: 1,
          },
          {
            id: "vload1",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.load",
            min: 0,
          },
          {
            id: "vex2",
            kind: "catalogExercise",
            full: true,
            labelKey: "calculators.fields.exercise2",
            optional: true,
          },
          {
            id: "vsets2",
            kind: "number",
            labelKey: "calculators.fields.setsCount",
            min: 1,
            step: 1,
            optional: true,
          },
          {
            id: "vreps2",
            kind: "number",
            unit: "reps",
            labelKey: "calculators.fields.repsPerSet",
            min: 1,
            step: 1,
            optional: true,
          },
          {
            id: "vload2",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.load",
            min: 0,
            optional: true,
          },
          {
            id: "vex3",
            kind: "catalogExercise",
            full: true,
            labelKey: "calculators.fields.exercise3",
            optional: true,
          },
          {
            id: "vsets3",
            kind: "number",
            labelKey: "calculators.fields.setsCount",
            min: 1,
            step: 1,
            optional: true,
          },
          {
            id: "vreps3",
            kind: "number",
            unit: "reps",
            labelKey: "calculators.fields.repsPerSet",
            min: 1,
            step: 1,
            optional: true,
          },
          {
            id: "vload3",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.load",
            min: 0,
            optional: true,
          },
          {
            id: "sessions",
            kind: "number",
            labelKey: "calculators.fields.sessionsPerWeek",
            min: 1,
            max: 7,
            step: 1,
          },
        ],
        prefill: () => ({ sessions: 1 }),
        compute: (v, units) => {
          const entries = [1, 2, 3].flatMap((k) => {
            const id = str(v, `vex${k}`);
            const sets = num(v, `vsets${k}`);
            const reps = num(v, `vreps${k}`);
            if (!id || sets == null || reps == null) return [];
            const load = num(v, `vload${k}`) ?? 0;
            return [{ exercise_id: id, sets, reps, weight_kg: kgFromDisplay(load, units) }];
          });
          if (!entries.length) return null;
          return {
            ...computeTrainingVolume({ entries, sessions_per_week: num(v, "sessions") }),
            units,
          };
        },
      },
    ],
  },
  // ============================ CARDIO & TRAINING ==============================
  {
    id: "cardio",
    titleKey: "calculators.sections.cardio",
    Icon: HeartPulse,
    calculators: [
      {
        id: "vo2max",
        toolName: "estimate_vo2_max",
        titleKey: "calculators.vo2max.title",
        descKey: "calculators.vo2max.desc",
        fields: [
          {
            id: "sex",
            kind: "segmented",
            labelKey: "calculators.fields.sex",
            options: SEX_OPTIONS,
          },
          { id: "age", kind: "number", unit: "years", labelKey: "calculators.fields.age" },
          {
            id: "restingHr",
            kind: "number",
            unit: "bpm",
            labelKey: "calculators.fields.restingHr",
            min: 30,
            max: 120,
            infoKey: "calculators.info.restingHr",
          },
          {
            id: "maxHr",
            kind: "number",
            unit: "bpm",
            labelKey: "calculators.fields.maxHr",
            optional: true,
            infoKey: "calculators.info.maxHr",
          },
        ],
        prefill: (ctx) => ({ sex: ctx.profile?.sex ?? undefined, age: ageFromCtx(ctx) }),
        compute: (v) => {
          const sex = sexOf(v);
          const age = num(v, "age");
          const rhr = num(v, "restingHr");
          if (!sex || age == null || rhr == null) return null;
          const maxHr = num(v, "maxHr");
          const vo2 = computeVo2Max({
            sex,
            age,
            resting_heart_rate: rhr,
            max_heart_rate: maxHr ?? null,
          });
          // Heart-rate zones share every input, so the one calculator shows both
          // (Karvonen, since a resting heart rate is always given here).
          const zones = computeHeartRateZones({
            age,
            resting_heart_rate: rhr,
            max_heart_rate: maxHr ?? null,
          });
          return { ...vo2, zones };
        },
        // Two chat cards stacked: the VO₂max score, then the training zones.
        renderResult: (data) => {
          const Vo2Card = getResultCard("estimate_vo2_max");
          const ZonesCard = getResultCard("compute_heart_rate_zones");
          const zones = (data as { zones?: unknown }).zones;
          return createElement(
            "div",
            { className: "space-y-3" },
            Vo2Card && createElement(Vo2Card, { data, category: categoryOf("estimate_vo2_max") }),
            ZonesCard && zones
              ? createElement(ZonesCard, {
                  data: zones,
                  category: categoryOf("compute_heart_rate_zones"),
                })
              : null,
          );
        },
      },
      {
        id: "step_calories",
        toolName: "compute_step_calories",
        titleKey: "calculators.stepCalories.title",
        descKey: "calculators.stepCalories.desc",
        fields: [
          { id: "steps", kind: "number", labelKey: "calculators.fields.steps", min: 0, step: 100 },
          {
            id: "sex",
            kind: "segmented",
            labelKey: "calculators.fields.sex",
            options: SEX_OPTIONS,
          },
          { id: "weight", kind: "number", unit: "weight", labelKey: "calculators.fields.weight" },
          { id: "height", kind: "number", unit: "length", labelKey: "calculators.fields.height" },
          {
            id: "age",
            kind: "number",
            unit: "years",
            labelKey: "calculators.fields.age",
            optional: true,
          },
          {
            id: "pace",
            kind: "segmented",
            full: true,
            cols: 2,
            labelKey: "calculators.fields.pace",
            options: PACE_OPTIONS,
          },
        ],
        prefill: (ctx, units) => ({
          steps: 10000,
          sex: ctx.profile?.sex ?? undefined,
          weight: weightSeed(ctx, units),
          height: heightSeed(ctx, units),
          age: ageFromCtx(ctx),
          pace: "brisk",
        }),
        compute: (v, units) => {
          const steps = num(v, "steps");
          const sex = sexOf(v);
          const w = num(v, "weight");
          const h = num(v, "height");
          if (steps == null || !sex || w == null || h == null) return null;
          return {
            ...computeStepCalories({
              steps,
              sex,
              weight_kg: kgFromDisplay(w, units),
              height_cm: cmFromDisplay(h, units),
              pace: str(v, "pace") === "slow" ? "slow" : "brisk",
              age: num(v, "age") ?? null,
            }),
            units,
          };
        },
      },
      {
        id: "resistance_kcal",
        // Reuses the training category for theming; the result is rendered by
        // renderResult (TrainingBurnHeadline), not a chat result card.
        toolName: "estimate_training_kcal",
        titleKey: "calculators.resistanceKcal.title",
        descKey: "calculators.resistanceKcal.desc",
        fields: [
          { id: "weight", kind: "number", unit: "weight", labelKey: "calculators.fields.avgLoad" },
          {
            id: "reps",
            kind: "number",
            unit: "reps",
            labelKey: "calculators.fields.repsPerSet",
            min: 1,
            step: 1,
          },
          { id: "sets", kind: "number", labelKey: "calculators.fields.setsCount", min: 1, step: 1 },
        ],
        prefill: () => ({}),
        compute: (v, units) => {
          const w = num(v, "weight");
          const reps = num(v, "reps");
          const sets = num(v, "sets");
          if (w == null || reps == null || sets == null) return null;
          // Work is linear in load × total reps, so one combined pseudo-set with
          // reps×sets reps gives the same tonnage/energy as the individual sets.
          return estimateResistanceKcal([
            { weight_kg: kgFromDisplay(w, units), reps: reps * sets },
          ]);
        },
        renderResult: (data, t) => {
          const d = data as { total_kcal?: number; total_volume_kg?: number } | null;
          if (!d || d.total_kcal == null) return null;
          return createElement(TrainingBurnHeadline, {
            kcal: d.total_kcal,
            estimated: true,
            sub: t("calculators.resistanceKcal.volume", {
              volume: Math.round(d.total_volume_kg ?? 0).toLocaleString(),
            }),
          });
        },
      },
      {
        id: "training_kcal",
        toolName: "estimate_training_kcal",
        titleKey: "calculators.trainingKcal.title",
        descKey: "calculators.trainingKcal.desc",
        fields: [
          {
            id: "weight",
            kind: "number",
            unit: "weight",
            labelKey: "calculators.fields.bodyweight",
          },
          {
            id: "activity",
            kind: "select",
            full: true,
            labelKey: "calculators.fields.activityType",
            options: ACTIVITY_MET_OPTIONS,
          },
          {
            id: "duration",
            kind: "number",
            unit: "min",
            labelKey: "calculators.fields.duration",
            min: 1,
            step: 1,
          },
        ],
        prefill: (ctx, units) => ({
          weight: weightSeed(ctx, units),
          activity: "running_easy",
          duration: 30,
        }),
        compute: (v, units) => {
          const w = num(v, "weight");
          const activity = str(v, "activity");
          const dur = num(v, "duration");
          if (w == null || !activity || dur == null) return null;
          return estimateTrainingKcal(kgFromDisplay(w, units), [{ activity, duration_min: dur }]);
        },
      },
    ],
  },
];
