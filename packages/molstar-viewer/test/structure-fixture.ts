import { parsePDB } from "molstar/lib/mol-io/reader/pdb/parser.js";
import { trajectoryFromPDB } from "molstar/lib/mol-model-formats/structure/pdb.js";
import { Structure, StructureElement } from "molstar/lib/mol-model/structure.js";

export async function loadStructure(pdb: string): Promise<Structure> {
  const parsed = await parsePDB(pdb).run();
  if (parsed.isError) throw new Error(parsed.message);
  const trajectory = await trajectoryFromPDB(parsed.result).run();
  return Structure.ofModel(trajectory.representative);
}

export function atomCount(loci: StructureElement.Loci): number {
  return StructureElement.Loci.size(loci);
}

/** Two atoms per residue, so a residue selection is 2 atoms. */
export function residue(name: string, chain: string, resno: number, x: number): string {
  const serial = (resno - 1) * 2 + 1;
  return [
    `ATOM  ${String(serial).padStart(5)}  N   ${name} ${chain}${String(resno).padStart(4)}     ${x.toFixed(3).padStart(8)}   0.000   0.000  1.00  0.00           N`,
    `ATOM  ${String(serial + 1).padStart(5)}  CA  ${name} ${chain}${String(resno).padStart(4)}     ${(x + 1).toFixed(3).padStart(8)}   0.000   0.000  1.00  0.00           C`,
  ].join("\n");
}

export function pdb(residues: string[]): string {
  return `${residues.join("\n")}\nEND\n`;
}
