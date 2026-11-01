import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { humanizeFoodName, type ResolvedRecipe } from "@fa/shared";
import i18n from "../i18n";
import { MacroCells, MacroStats, PrintHeader, printDocument } from "./printDoc";
import { MacroSplit, ShareBar } from "./printViz";

function RecipeDoc({ recipe }: { recipe: ResolvedRecipe }) {
  const { t } = useTranslation();
  return (
    <>
      <PrintHeader
        kind={t("export.kinds.recipe")}
        title={recipe.name}
        subtitle={`${t("recipes.servingsCount", { count: recipe.servings })} · ${t(
          "recipes.ingredientsCount",
          { count: recipe.ingredients.length },
        )}`}
      />
      <h2>{t("recipes.perServing")}</h2>
      <MacroStats
        macros={recipe.per_serving}
        label={
          recipe.servings > 1
            ? t("recipes.wholeRecipe", { kcal: Math.round(recipe.totals.kcal) })
            : undefined
        }
      />
      <MacroSplit macros={recipe.per_serving} />
      <h2>{t("recipes.ingredients")}</h2>
      <table>
        <thead>
          <tr>
            <th>{t("export.diet.food")}</th>
            <th className="num">{t("export.diet.grams")}</th>
            <th style={{ width: "18%" }}>{t("export.recipe.kcalShare")}</th>
            <th className="num">{t("export.kcal")}</th>
            <th className="num">{t("export.proteinShort")}</th>
            <th className="num">{t("export.fatShort")}</th>
            <th className="num">{t("export.carbsShort")}</th>
          </tr>
        </thead>
        <tbody>
          {recipe.ingredients.map((it) => (
            <tr key={it.id}>
              <td>
                {humanizeFoodName(it.food)}
                {it.resolved == null && <span className="warn"> · {t("recipes.needsMacros")}</span>}
              </td>
              <td className="num">{Math.round(it.grams)} g</td>
              <td>
                {it.resolved && (
                  <span className="share">
                    <ShareBar value={it.resolved.kcal} max={recipe.totals.kcal} />
                    <span className="small muted num">
                      {Math.round((it.resolved.kcal / (recipe.totals.kcal || 1)) * 100)}%
                    </span>
                  </span>
                )}
              </td>
              <MacroCells m={it.resolved} />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>{t("export.recipe.wholeRecipe")}</td>
            <td />
            <td />
            <MacroCells m={recipe.totals} />
          </tr>
        </tfoot>
      </table>
      {recipe.instructions && (
        <>
          <h2>{t("recipes.instructions")}</h2>
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{recipe.instructions}</ReactMarkdown>
          </div>
        </>
      )}
      {recipe.notes && (
        <>
          <h2>{t("export.recipe.notes")}</h2>
          <p>{recipe.notes}</p>
        </>
      )}
      {recipe.source_url && (
        <p className="small muted">
          {t("recipes.source")}: <a href={recipe.source_url}>{recipe.source_url}</a>
        </p>
      )}
    </>
  );
}

export function exportRecipePdf(recipe: ResolvedRecipe): Promise<void> {
  return printDocument(
    `${recipe.name} — ${i18n.t("export.kinds.recipe")}`,
    <RecipeDoc recipe={recipe} />,
  );
}
