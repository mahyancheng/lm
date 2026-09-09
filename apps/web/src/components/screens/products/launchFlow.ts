/**
 * Pure derivations for the launch flow: Industry → Line → Built on → Terms.
 *
 * Nothing here computes an economic number or a lock decision of its own.
 * `lineLock` runs the identical `dependencySatisfied` test the validator's
 * `launch_product` rule runs against `category.requiresNodeIds`, so a line
 * this module marks open is a line the validator accepts, and a line it marks
 * locked names exactly the node the validator would refuse it for.
 * `builtOnRows` reads `suppliersFor`, the same lookup the Chief of Staff's
 * `suppliers` lookup and `resolveSupplyLine` itself read — nothing here
 * invents a price, a quality score or an offer that is not a real published
 * line somewhere in the session.
 */

import type { Company, ProductCategory, ProductCategoryInput, Sector, SessionState } from '@frontier/contracts';
import { SECTORS, categoryById } from '@frontier/contracts';
import { categoryOf, dependencySatisfied, suppliersFor, type SupplyOffer } from '@frontier/simulation';

/** The six sectors, `company`'s own first — the order the Industry step offers them in. */
export function industriesForCompany(company: Pick<Company, 'sector'>): readonly Sector[] {
  const own = company.sector ?? 'ai';
  return [own, ...SECTORS.filter((sector) => sector !== own)];
}

export interface LineLock {
  readonly locked: boolean;
  /** Frontier Map node ids still missing. Empty exactly when `locked` is false. */
  readonly missingNodeIds: readonly string[];
}

/**
 * Whether `company` may launch into `category` right now — the same
 * `requiresNodeIds` test `launchProduct`'s validator rule runs. Pure and
 * total: a category with no requirement is never locked.
 */
export function lineLock(session: SessionState, company: Pick<Company, 'id'>, category: ProductCategory): LineLock {
  const missingNodeIds = category.requiresNodeIds.filter((nodeId) => !dependencySatisfied(session, nodeId, company.id));
  return { locked: missingNodeIds.length > 0, missingNodeIds };
}

/** Node titles for a lock's `missingNodeIds`, resolved against the graph. Falls back to the raw id for a node the graph no longer carries. */
export function missingNodeTitles(session: SessionState, missingNodeIds: readonly string[]): readonly string[] {
  return missingNodeIds.map((nodeId) => session.techGraph.nodes.find((node) => node.id === nodeId)?.title ?? nodeId);
}

/* -------------------------------------------------------------------------- */
/*  Built on                                                                   */
/* -------------------------------------------------------------------------- */

export type BuiltOnOptionKind = 'open_market' | 'own_line' | 'offer';

export interface BuiltOnOption {
  readonly kind: BuiltOnOptionKind;
  readonly supplierCompanyId: string | null;
  readonly supplierProductId: string | null;
  readonly label: string;
  /** The published offer this option came from, or null for "open market" and "your own line". */
  readonly offer: SupplyOffer | null;
}

export interface BuiltOnRow {
  readonly input: ProductCategoryInput;
  /** The upstream category this input names, or null for a stale id the catalogue no longer carries. */
  readonly category: ProductCategory | null;
  /** "Open market" first (the default, always legal), then the buyer's own supplying line if it has one, then every published offer, best quality per dollar first. */
  readonly options: readonly BuiltOnOption[];
}

const OPEN_MARKET_OPTION: BuiltOnOption = { kind: 'open_market', supplierCompanyId: null, supplierProductId: null, label: 'Open market', offer: null };

/**
 * For every input a category declares: the always-legal open-market default,
 * the buyer's own supplying line when it already has one, and every company
 * currently publishing that input to this buyer — from `suppliersFor`, so an
 * offer shown here is a real published line, not a modelled price.
 */
export function builtOnRows(session: SessionState, company: Company, category: ProductCategory): readonly BuiltOnRow[] {
  return category.inputs.map((input) => {
    const inputCategory = categoryById(input.categoryId) ?? null;
    const options: BuiltOnOption[] = [OPEN_MARKET_OPTION];

    const ownLine = company.products.find(
      (product) => product.isActive && product.supplyTerms != null && categoryOf(company, product).id === input.categoryId,
    );
    if (ownLine !== undefined) {
      options.push({ kind: 'own_line', supplierCompanyId: company.id, supplierProductId: ownLine.id, label: `Your own line — ${ownLine.name}`, offer: null });
    }

    for (const offer of suppliersFor(session, company.id, input.categoryId)) {
      options.push({ kind: 'offer', supplierCompanyId: offer.company.id, supplierProductId: offer.product.id, label: offer.company.name, offer });
    }

    return { input, category: inputCategory, options };
  });
}

/** Every input a category declares that has no offer at all — nobody publishes it, and the buyer has no line of its own. */
export function unservedRequiredInputs(rows: readonly BuiltOnRow[]): readonly BuiltOnRow[] {
  return rows.filter((row) => row.input.required && row.options.length <= 1);
}

/* -------------------------------------------------------------------------- */
/*  Selection state                                                           */
/* -------------------------------------------------------------------------- */

/** One input category's chosen supplier, keyed the way `LaunchSupplyChoice[]` is built from it. */
export type SupplyChoiceMap = Readonly<Record<string, { supplierCompanyId: string | null; supplierProductId: string | null }>>;

/** `SupplyChoiceMap` as the `launch_product.supply` array the action expects — open-market choices (both fields null) are dropped, since an absent entry means exactly the same thing. */
export function supplyChoicesFrom(selections: SupplyChoiceMap): { inputCategoryId: string; supplierCompanyId: string | null; supplierProductId: string | null }[] {
  return Object.entries(selections)
    .filter(([, choice]) => choice.supplierCompanyId !== null)
    .map(([inputCategoryId, choice]) => ({ inputCategoryId, supplierCompanyId: choice.supplierCompanyId, supplierProductId: choice.supplierProductId }));
}
