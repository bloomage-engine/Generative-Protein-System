import { MolScriptSymbolTable } from "molstar/lib/mol-script/language/symbol-table.js";
import {
  DefaultQueryRuntimeTable,
  QuerySymbolRuntime,
} from "molstar/lib/mol-script/runtime/query/base.js";
import { Structure } from "molstar/lib/mol-model/structure.js";
import type { QueryContext } from "molstar/lib/mol-model/structure/query/context.js";
import { intersect as intersectQueries } from "molstar/lib/mol-model/structure/query/queries/combinators.js";
import { StructureSelection } from "molstar/lib/mol-model/structure/query/selection.js";
import { checkStructureMinMaxDistance } from "molstar/lib/mol-model/structure/query/utils/structure-distance.js";

const noRadius = () => 0;

/**
 * Mol* ships `distanceCluster` in its symbol table but leaves the runtime
 * implementation as a TODO. This is the documented behavior: `matrix[i][j]`
 * (upper triangle) is the maximum distance between selections i and j,
 * `matrix[j][i]` (lower triangle) the minimum. A combination of atom sets is
 * kept when every pair's closest atoms fall in `[min, max)`.
 */
export function distanceCluster(
  ctx: QueryContext,
  matrix: number[][],
  selections: StructureSelection[],
): StructureSelection {
  const size = selections.length;
  if (size === 0) return StructureSelection.Empty(ctx.inputStructure);
  if (!isMatrix(matrix, size)) {
    throw new Error(
      `dist-cluster: :matrix must be a ${size}x${size} numeric matrix for ${size} selection(s).`,
    );
  }

  const groups = selections.map((selection) => {
    const sets: Structure[] = [];
    StructureSelection.forEach(selection, (set) => {
      if (set.elementCount > 0) sets.push(set);
    });
    return sets;
  });
  if (groups.some((sets) => sets.length === 0)) {
    return StructureSelection.Empty(ctx.inputStructure);
  }

  const result = StructureSelection.UniqueBuilder(ctx.inputStructure);
  const chosen: Structure[] = [];
  let steps = 0;

  const visit = (index: number): void => {
    if (index === size) {
      for (const set of chosen) result.add(set);
      return;
    }
    for (const candidate of groups[index]!) {
      let valid = true;
      for (let previous = 0; previous < index; previous++) {
        const earlier = chosen[previous]!;
        if (Structure.areUnitIdsAndIndicesEqual(earlier, candidate)) {
          valid = false;
          break;
        }
        const min = matrix[index]![previous]!;
        const max = matrix[previous]![index]!;
        if (!checkStructureMinMaxDistance(ctx, earlier, candidate, min, max, noRadius)) {
          valid = false;
          break;
        }
      }
      if (!valid) continue;
      chosen[index] = candidate;
      if (++steps % 100 === 0) ctx.throwIfTimedOut();
      visit(index + 1);
    }
  };

  visit(0);
  return result.getSelection();
}

function isMatrix(matrix: unknown, size: number): matrix is number[][] {
  return (
    Array.isArray(matrix) &&
    matrix.length === size &&
    matrix.every(
      (row) =>
        Array.isArray(row) &&
        row.length === size &&
        row.every((value) => typeof value === "number" && Number.isFinite(value)),
    )
  );
}

/**
 * Mol* 5.9.0 exposes `sel.atom.intersect` in the parser but never registers
 * its (existing) runtime implementation, and `dist-cluster` is not implemented
 * at all. Register both so the skill's documented MolQL compiles.
 */
export function registerMissingMolstarCombinators(): void {
  const intersectSymbol = MolScriptSymbolTable.structureQuery.combinator.intersect;
  if (!DefaultQueryRuntimeTable.getRuntime(intersectSymbol.id)) {
    DefaultQueryRuntimeTable.addSymbol(
      QuerySymbolRuntime.Dynamic(intersectSymbol, (ctx, args) =>
        intersectQueries(args as unknown as Parameters<typeof intersectQueries>[0])(ctx),
      ),
    );
  }

  const clusterSymbol = MolScriptSymbolTable.structureQuery.combinator.distanceCluster;
  if (!DefaultQueryRuntimeTable.getRuntime(clusterSymbol.id)) {
    DefaultQueryRuntimeTable.addSymbol(
      QuerySymbolRuntime.Dynamic(clusterSymbol, (ctx, args) =>
        distanceCluster(
          ctx,
          args["matrix"](ctx) as number[][],
          args["selections"](ctx) as unknown as StructureSelection[],
        ),
      ),
    );
  }
}
