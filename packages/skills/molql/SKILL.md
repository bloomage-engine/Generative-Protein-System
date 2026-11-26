---
name: molql
description: This skill should be used when users need to translate natural language molecular structure queries into MolQL (Mol-Script) expressions, or to measure a structure (distance, angle, dihedral, orientation, plane). It handles basic atom/residue/chain selection, distance-based queries, property-based filtering, complex multi-part queries, and provides clarification for ambiguous requests.
---

# MolQL Translator Skill

## Purpose

This skill translates natural language molecular structure queries into valid MolQL (Mol-Script) expressions. It enables users to describe what they want to select, visualize or measure in natural language, and applies the resulting selection to the molecular structure viewer that is open in the Generative Protein System web app.

The selection is delivered by calling the `molql` **tool** — never by printing the expression in a code block. The tool forwards the expression to the viewer, which compiles it with Mol* and highlights/focuses the matching atoms. Measurements are delivered by the separate `measurements` tool (see "Measuring" below).

## Which structure file?

The `molql` tool takes no file argument: it always targets the structure file the user is **currently viewing**. That is intentional — the user picks the file in the viewer, not the model. If the `molql` tool reports that **no structure file is open**, do NOT assume the selection was applied: ask the user to open the structure file (.pdb, .cif, …) they want to operate on.

The `measurements` and `computeInteraction` tools DO need a file. Resolve it in this order:

1. **The user named one** (a path in words, or a `@…` mention) → pass `project`/`path` from it.
2. **Otherwise omit `project`/`path`** → the service targets the file the user currently has open. **Do NOT reuse a file path from earlier in the conversation** — the open file may have changed since.
3. **Neither is available** → the call fails with a message saying no file is open; relay it as a question ("which structure file should I use?").


## When to Use

Trigger this skill when users:
- Ask to select specific chains, residues, or atoms in natural language (e.g., "select chain A", "show residues 10-20")
- Request distance-based selections (e.g., "find atoms within 5Å of the ligand")
- Want property-based filtering (e.g., "show residues with B-factor greater than 30")
- Need complex combinatory queries (e.g., "select helices in chain A that are connected to heme")
- Make ambiguous molecular selection requests that need clarification

**Do NOT use** for:
- General molecular biology questions unrelated to structure selection

## How to Use

### Translation Workflow

1. **Parse the user's natural language request** to identify:
   - Selection target (chain, residue, atom, element, entity type)
   - Constraints (ranges, properties, distances)
   - Operations (union, intersection, exclusion, expansion)

2. **Map to MolQL patterns** using the reference syntax in `references/molql-syntax.md`:
   - Basic selections → `(sel.atom.chains ...)`, `(sel.atom.res ...)`, `(sel.atom.atoms ...)`
   - Distance queries → `(sel.atom.within ...)`, `(sel.atom.include-surroundings ...)`
   - Property filters → `(sel.atom.pick :test ...)`
   - Complex queries → Combine with `(sel.atom.merge ...)`, `(sel.atom.intersect ...)`

3. **Construct the MolQL expression** following S-expression syntax:
   - Use space-separated arguments
   - Named parameters use `:` prefix
   - Nested expressions for complex logic

4. **Deliver the expression by calling the `molql` tool** with:
   - `molql` (required): the MolQL expression, e.g. `(sel.atom.res (in-range atom.resno 10 20))`
   - `description` (optional): a short explanation shown alongside the call
   - `focus` (optional, default `true`): whether to move the camera to the selection

   Then, in your reply, give the expression and a one-line explanation as plain
   text for the user. Do not use the tool until you are confident the expression
   is valid; the viewer reports a syntax error if it is not.

## Measuring (the `measurements` tool)

Selection answers "what"; measurement answers "how much". When the user asks for a
distance, angle, dihedral, label, orientation or best-fit plane, call the
**`measurements`** tool:

- `kind`: `label` | `distance` | `angle` | `dihedral` | `orientation` | `plane`
- `selections` (required): the **ordered** selection items, each a MolQL
  expression or a full `@project/path/molql` mention produced by clicking in the
  viewer. Order is A, B, C, D and matters:
  - `label` → 1 item
  - `distance` → 2 items (A—B)
  - `angle` → 3 items (A—B—C; the angle is at the middle item B)
  - `dihedral` → 4 items (A—B—C—D)
  - `orientation` / `plane` → 1 or more items (a set)
- `project` / `path` (optional): read from the first mention when the items are
  mentions; otherwise pass them explicitly. If the user named no file, omit them
  (see "Which structure file?").

Examples of the MolQL you pass as selection items:

| User asks | selection item |
|---|---|
| "the distance between residue 42 and residue 87" | `(sel.atom.res (= atom.resno 42))`, `(sel.atom.res (= atom.resno 87))` |
| "distance between the CA atoms of residues 42 and 87" | `(sel.atom.atoms (and (= atom.resno 42) (= atom.name CA)))`, `(sel.atom.atoms (and (= atom.resno 87) (= atom.name CA)))` |
| "the angle at the iron between His 45 and His 90" | `(sel.atom.atoms (= atom.name NE2))`… prefer explicit atoms |
| "the plane of the heme" | `(sel.atom.res (= atom.resname HEM))` |

The tool returns the value (Å for distance, degrees for angle/dihedral, or the
fitted axes/plane) **and** draws the same measurement in the 3D view. A click
mention already contains a complete MolQL expression — pass it through unchanged
as the ordered selection item; only translate when the user describes the
selection in words.

### Query Categories and Patterns

#### Basic Selection

| Natural Language | MolQL Pattern |
|-----------------|---------------|
| "Select chain A" | `(sel.atom.chains (= atom.chain A))` |
| "Show residues 10-20" | `(sel.atom.res (in-range atom.resno 10 20))` |
| "Select alanine residues" | `(sel.atom.res (= atom.resname ALA))` |
| "Show carbon atoms" | `(sel.atom.atoms (= atom.el C))` |
| "Select CA atoms" | `(sel.atom.atoms (= atom.name CA))` |

#### Distance-Based Queries

| Natural Language | MolQL Pattern |
|-----------------|---------------|
| "Atoms within 5Å of iron" | `(sel.atom.include-surroundings (sel.atom.atoms (= atom.el _Fe)) :radius 5 :as-whole-residues true)` |
| "Residues near the ligand" | `(sel.atom.within (sel.atom.atom-groups :residue-test (= atom.entity-type non-polymer)) :target (sel.atom.atom-groups :entity-test (= atom.entity-type polymer)) :max-radius 5)` |

#### Property-Based Filtering

| Natural Language | MolQL Pattern |
|-----------------|---------------|
| "Residues with B-factor > 30" | `(sel.atom.pick (sel.atom.res (= atom.entity-type polymer)) :test (> atom.bfactor 30))` |
| "Show modified residues" | `(sel.atom.res atom.is-modified)` |

#### Complex Queries

| Natural Language | MolQL Pattern |
|-----------------|---------------|
| "Chain A and chain B" | `(sel.atom.merge (sel.atom.chains (= atom.chain A)) (sel.atom.chains (= atom.chain B)))` |
| "Helices in chain A" | `(sel.atom.pick (sel.atom.chains (= atom.chain A)) :test (core.flags.has-any atom.key.sec-struct (secondary-structure-flags helix)))` |
| "Everything except chain A" | `(sel.atom.except-by (sel.atom.all) :by (sel.atom.chains (= atom.chain A)))` |

### Ambiguous Query Handling

When the user's request is ambiguous, ask clarifying questions:

**Ambiguous**: "Select the active site"
**Clarification**: "Active site can be defined in different ways. Do you want to:
1. Select residues within a certain distance of a ligand/metal ion?
2. Select residues based on known catalytic residues?
3. Select based on secondary structure elements?
Please specify which approach, or provide more details."

**Ambiguous**: "Show the binding pocket"
**Clarification**: "To select the binding pocket, I need to know:
1. Which ligand or cofactor defines the binding site?
2. What radius should I use (typically 5-8Å)?
3. Should I include whole residues or just atoms within the radius?"

### Bundled Resources

- **`references/molql-syntax.md`**: Complete MolQL syntax reference manual (1150 lines) covering all operators, selectors, atom properties, and examples. Load this reference when you need to look up specific syntax patterns or verify expression structure.

### Key MolQL Concepts

#### Selection Levels
- **Atoms**: Individual atoms - use `(sel.atom.atoms test)`
- **Residues**: Grouped by residue - use `(sel.atom.res test)`
- **Chains**: Grouped by chain - use `(sel.atom.chains test)`

#### Common Properties
- `atom.chain` - Chain ID (A, B, C...)
- `atom.resno` - Residue sequence number
- `atom.resname` - Residue name (ALA, GLY, etc.)
- `atom.name` - Atom name (CA, CB, N, C, O...)
- `atom.el` - Element symbol (C, N, O, Fe...)
- `atom.bfactor` - B-factor (temperature factor)
- `atom.entity-type` - Entity type (polymer, non-polymer, water)

#### Logical Operators
- `(= a b)` - Equal
- `(!= a b)` - Not equal
- `(< a b)`, `(> a b)` - Less/greater than
- `(in-range v min max)` - Range check
- `(and c1 c2)` - Logical AND
- `(or c1 c2)` - Logical OR
- `(not c)` - Logical NOT
- `(set.has {A B C} value)` - Set membership

#### Common Modifiers
- `(sel.atom.merge s1 s2 ...)` - Union of selections
- `(sel.atom.intersect s1 s2 ...)` - Intersection
- `(sel.atom.except-by s :by other)` - Exclusion
- `(sel.atom.include-surroundings s :radius 5)` - Expand by distance
- `(sel.atom.include-connected s :layer-count 2)` - Expand by connectivity

## Examples

### Example 1: Simple Chain Selection
**User**: "Select chain A"

**Response**:
```lisp
(sel.atom.chains (= atom.chain A))
```
**Explanation**: Selects all atoms in chain A, grouped by chain.

### Example 2: Residue Range
**User**: "Show me residues 130 to 180"

**Response**:
```lisp
(sel.atom.res (in-range atom.resno 130 180))
```
**Explanation**: Selects all residues with sequence numbers between 130 and 180 (inclusive), grouped by residue.

### Example 3: Distance Query
**User**: "Find residues within 5 angstroms of the iron atom"

**Response**:
```lisp
(sel.atom.include-surroundings
  (sel.atom.atoms (= atom.el _Fe))
  :radius 5
  :as-whole-residues true)
```
**Explanation**: First selects iron atoms, then expands the selection to include all residues with any atom within 5Å of the iron.

### Example 4: Property Filter
**User**: "Which residues have high B-factors, say above 50?"

**Response**:
```lisp
(sel.atom.pick
  (sel.atom.res (= atom.entity-type polymer))
  :test (> atom.bfactor 50))
```
**Explanation**: Selects polymer residues where the B-factor is greater than 50.

### Example 5: Complex Query
**User**: "Select all helices in chain A that are near the heme group"

**Response**:
```lisp
(sel.atom.within
  (sel.atom.pick
    (sel.atom.chains (= atom.chain A))
    :test (core.flags.has-any
      atom.key.sec-struct
      (secondary-structure-flags helix)))
  :target (sel.atom.res (= atom.resname HEM))
  :max-radius 5)
```
**Explanation**: First selects helical secondary structure elements in chain A, then filters to only those within 5Å of HEM residues.

## Troubleshooting

### Common Mistakes

1. **Wrong selector level**: Using `sel.atom.atoms` when you want residue-level selection. Remember:
   - Use `sel.atom.atoms` for individual atom selection
   - Use `sel.atom.res` for residue-level grouping
   - Use `sel.atom.chains` for chain-level grouping

2. **Missing named parameter colon**: Named parameters must have `:` prefix
   - ❌ `(sel.atom.include-surroundings sel radius 5)`
   - ✅ `(sel.atom.include-surroundings sel :radius 5)`

3. **Wrong element symbol format**: Element symbols in comparisons use underscore prefix
   - ❌ `(= atom.el Fe)`
   - ✅ `(= atom.el _Fe)`

4. **String vs symbol**: Chain IDs and residue names are symbols, not strings
   - ❌ `(= atom.chain "A")`
   - ✅ `(= atom.chain A)`

### When Translation Fails

If you cannot confidently translate a query:
1. Explain which part is ambiguous
2. Ask for clarification
3. Suggest possible interpretations
4. Provide MolQL for the most likely interpretation as a starting point
