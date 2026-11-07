import { useEffect, useRef, useState } from "react";
import type {
  HousingIncomeLimitCatalog,
  HousingIncomeLimitPack,
} from "@urban/core";
import {
  fetchHousingCatalog,
  fetchHousingPack,
  type HousingCatalogResponse,
} from "../../lib/housing-api";
import { HousingField } from "./HousingFields";
export function HousingAreaEvidence({
  pack,
}: {
  pack: HousingIncomeLimitPack;
}) {
  const money = (n: number) =>
    n.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
  return (
    <section className="housing-area-evidence">
      <h3>{pack.area.name}</h3>
      <p>
        HUD Section 8 · FY {pack.fiscalYear} · effective {pack.effectiveDate}
      </p>
      <details>
        <summary>
          Jurisdiction components and exceptions ({pack.area.geographies.length}
          )
        </summary>
        <ul>
          {pack.area.geographies.map((g, i) => (
            <li key={i}>
              {g.name} · state {g.stateFips}, county {g.countyFips}
              {g.countySubdivisionFips
                ? `, subdivision ${g.countySubdivisionFips}`
                : ""}
            </li>
          ))}
        </ul>
      </details>
      <div
        className="housing-table-scroll"
        tabIndex={0}
        role="region"
        aria-label="Published annual income limits"
      >
        <table>
          <caption>Published annual income limits · dollars</caption>
          <thead>
            <tr>
              <th>People in household</th>
              <th>Extremely low</th>
              <th>Very low</th>
              <th>Low</th>
            </tr>
          </thead>
          <tbody>
            {pack.limits.map((r) => (
              <tr key={r.householdSize}>
                <th>{r.householdSize}</th>
                <td>{money(r.extremelyLow)}</td>
                <td>{money(r.veryLow)}</td>
                <td>{money(r.low)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        These are published, adjusted income limits, not literal percentages of
        area median income or a determination of program eligibility.
      </p>
      <details>
        <summary>Captured source and original rows</summary>
        {pack.sources.map((s) => (
          <p key={s.id}>
            <strong>{s.name}</strong> · {s.vintage}
            <br />
            {/^https?:\/\//iu.test(s.url ?? "") && (
              <a href={s.url} target="_blank" rel="noreferrer">
                Source publication
              </a>
            )}{" "}
            · {s.license}
          </p>
        ))}
        {pack.notes.map((n, i) => (
          <p key={i}>{n}</p>
        ))}
        <pre>
          {JSON.stringify(
            { files: pack.files, rows: pack.sourceRows },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}
export function HousingAreas({
  packs,
  onRetain,
}: {
  packs: HousingIncomeLimitCatalog;
  onRetain: (hash: string, pack: HousingIncomeLimitPack) => void;
}) {
  const [filters, setFilters] = useState({ q: "", state: "", county: "" });
  const [page, setPage] = useState<HousingCatalogResponse | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [selected, setSelected] = useState<{
      hash: string;
      pack: HousingIncomeLimitPack;
    } | null>(null),
    [ack, setAck] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  function changeFilters(next: typeof filters) {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setFilters(next);
    setPage(null);
  }
  async function search(cursor: string | null = null) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const next = await fetchHousingCatalog(
        filters,
        cursor,
        controller.signal,
      );
      if (request.current !== controller) return;
      setPage((old) =>
        cursor && old?.catalogHash === next.catalogHash
          ? { ...next, areas: [...old.areas, ...next.areas] }
          : next,
      );
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "The area catalog could not be loaded.",
        );
    } finally {
      if (request.current === controller) setBusy(false);
    }
  }
  async function select(hash: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setAck(false);
    setSelected(null);
    try {
      const pack = await fetchHousingPack(hash, controller.signal);
      if (request.current === controller) setSelected({ hash, pack });
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : "The area could not be loaded.",
        );
    } finally {
      if (request.current === controller) setBusy(false);
    }
  }
  return (
    <section>
      <h3>Choose the applicable HUD area</h3>
      <p>
        Search the published catalog, inspect its jurisdiction components, then
        retain the area for your unit groups. A ZIP code does not establish
        HUD-area membership.
      </p>
      <form
        className="housing-area-search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <div className="housing-search-primary">
          <HousingField
            label="Area or jurisdiction name"
            value={filters.q}
            onChange={(q) => {
              changeFilters({ ...filters, q });
            }}
          />
          <button className="housing-primary" type="submit" disabled={busy}>
            Search HUD areas
          </button>
        </div>
        <details className="housing-search-filters">
          <summary>Advanced jurisdiction filters</summary>
          <div className="housing-fields">
            <HousingField
              label="State FIPS"
              value={filters.state}
              hint="Optional two-digit code, such as 04."
              onChange={(state) => {
                changeFilters({ ...filters, state });
              }}
            />
            <HousingField
              label="County FIPS"
              value={filters.county}
              hint="Optional five-digit code, such as 04013."
              onChange={(county) => {
                changeFilters({ ...filters, county });
              }}
            />
          </div>
        </details>
      </form>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Loading the published catalog…</p>}
      {page && (
        <>
          <p>{page.areas.length} areas loaded</p>
          <ul className="housing-area-list">
            {page.areas.map((a) => (
              <li key={a.packHash}>
                <div>
                  <strong>{a.area.name}</strong>
                  <small>
                    FY {a.fiscalYear} · effective {a.effectiveDate} ·{" "}
                    {a.area.geographies.length} jurisdiction components
                  </small>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void select(a.packHash)}
                >
                  Review {a.area.name}
                </button>
              </li>
            ))}
          </ul>
          {page.nextCursor && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void search(page.nextCursor)}
            >
              Load more areas
            </button>
          )}
        </>
      )}
      {selected && (
        <div className="housing-card">
          <HousingAreaEvidence pack={selected.pack} />
          <label className="check">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            I reviewed the named jurisdiction components and exceptions for the
            buildings I will assign.
          </label>
          <button
            className="housing-primary"
            type="button"
            disabled={!ack || busy}
            onClick={() => {
              onRetain(selected.hash, selected.pack);
              setSelected(null);
              setAck(false);
            }}
          >
            Retain this HUD area
          </button>
        </div>
      )}
      <h3>Areas retained in this draft</h3>
      {Object.entries(packs).length ? (
        Object.entries(packs).map(([hash, pack]) => (
          <details key={hash}>
            <summary>
              {pack.area.name} · FY {pack.fiscalYear}
            </summary>
            <HousingAreaEvidence pack={pack} />
          </details>
        ))
      ) : (
        <p>No area selected yet.</p>
      )}
    </section>
  );
}
