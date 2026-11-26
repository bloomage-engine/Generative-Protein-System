import type { Molstar } from "./structure.js";

const noRadius = () => 0;

/**
 * Mol* ships `distanceCluster` in its symbol table but leaves the runtime
 * implementation as a TODO. This is the documented behavior: `matrix[i][j]`
 * (upper triangle) is the maximum distance between selections i and j,
 * `matrix[j][i]` (lower triangle) the minimum. A combination of atom sets is
 * kept when every pair's closest atoms fall in `[min, max)`.
 */
export function distanceCluster(
  m: Molstar,
  ctx: any,
  matrix: number[][],
  selections: any[],
): any {
  const size = selections.length;
  if (size === 0) return m.StructureSelection.Empty(ctx.inputStructure);
  if (!isMatrix(matrix, size)) {
    throw new Error(
      `dist-cluster: :matrix must be a ${size}x${size} numeric matrix for ${size} selection(s).`,
    );
  }

  const groups: any[][] = selections.map((selection) => {
    const sets: any[] = [];
    m.StructureSelection.forEach(selection, (set: any) => {
      if (set.elementCount > 0) sets.push(set);
    });
    return sets;
  });
  if (groups.some((sets) => sets.length === 0)) {
    return m.StructureSelection.Empty(ctx.inputStructure);
  }

  const result = m.StructureSelection.UniqueBuilder(ctx.inputStructure);
  const chosen: any[] = [];
  let steps = 0;

  const visit = (index: number): void => {
    if (index === size) {
      for (const set of chosen) result.add(set);
      return;
    }
    for (const candidate of groups[index]!) {
      let valid = true;
      for (let previous = 0; previous < index; previous++) {
        const earlier = chosen[previous];
        if (m.Structure.areUnitIdsAndIndicesEqual(earlier, candidate)) {
          valid = false;
          break;
        }
        const min = matrix[index]![previous]!;
        const max = matrix[previous]![index]!;
        if (!m.checkStructureMinMaxDistance(ctx, earlier, candidate, min, max, noRadius)) {
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

/** Register the two combinator gaps once per loaded molstar instance. */
export function registerMolstarCombinators(m: Molstar): void {
  const table = m.DefaultQueryRuntimeTable;
  const runtime = m.QuerySymbolRuntime;
  const symbols = m.MolScriptSymbolTable.structureQuery.combinator;

  if (!table.getRuntime(symbols.intersect.id)) {
    table.addSymbol(
      runtime.Dynamic(symbols.intersect, (ctx: any, args: any) =>
        m.combinators.intersect(args)(ctx),
      ),
    );
  }

  if (!table.getRuntime(symbols.distanceCluster.id)) {
    table.addSymbol(
      runtime.Dynamic(symbols.distanceCluster, (ctx: any, args: any) =>
        distanceCluster(m, ctx, args["matrix"](ctx), args["selections"](ctx)),
      ),
    );
  }
}
