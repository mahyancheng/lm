'use client';

/**
 * Sector and company narrowing, in a sheet rather than a permanent row.
 *
 * The chips and the select are the same primitives the old filter bar used;
 * what changed is where they live. A reader who never narrows never sees them.
 */

import type { Sector } from '@frontier/contracts';
import { Drawer, Icon, SectorFilter } from '@/components/ui';

export interface FilterCompanyOption {
  readonly id: string;
  readonly name: string;
  readonly count: number;
}

export interface FilterSheetProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly sectors: readonly Sector[];
  readonly sectorCounts: Readonly<Partial<Record<Sector, number>>>;
  readonly sector: Sector | null;
  readonly onSector: (sector: Sector | null) => void;
  readonly companies: readonly FilterCompanyOption[];
  readonly companyId: string | null;
  readonly onCompany: (companyId: string | null) => void;
}

export function FilterSheet({ open, onClose, sectors, sectorCounts, sector, onSector, companies, companyId, onCompany }: FilterSheetProps): React.JSX.Element {
  const narrowed = sector !== null || companyId !== null;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="bottom"
      title="Narrow the paper"
      subtitle="By industry, by company. The sections above narrow by kind."
      footer={
        <>
          {narrowed ? (
            <button
              type="button"
              className="btn btn-ghost tap-target"
              onClick={() => {
                onSector(null);
                onCompany(null);
              }}
            >
              Clear
            </button>
          ) : null}
          <button type="button" className="btn btn-primary tap-target" onClick={onClose}>
            <Icon name="check" size={15} accent="inherit" />
            Done
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {sectors.length < 2 ? null : (
          <div>
            <p className="label-caps mb-2">Industry</p>
            <SectorFilter sectors={sectors} value={sector} onChange={onSector} counts={sectorCounts} totalLabel="All industries" />
          </div>
        )}
        {companies.length < 2 ? null : (
          <div>
            <label className="label-caps mb-2 block" htmlFor="news-company-filter">
              Company
            </label>
            <select
              id="news-company-filter"
              className="field tap-target w-full text-[12px]"
              value={companyId ?? 'all'}
              onChange={(event) => onCompany(event.target.value === 'all' ? null : event.target.value)}
            >
              <option value="all">All companies</option>
              {companies.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name} ({entry.count})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </Drawer>
  );
}
