import { useEffect, useRef, useState } from "react";
import type { FiscalProfile } from "@urban/core";
import { fiscalApi, type FiscalProfileVersionView } from "../../lib/fiscal-api";
import {
  readLocalFiscalProfiles,
  type LocalFiscalProfile,
} from "../../lib/fiscal-library";

export function FiscalLibrary({
  scope,
  shared,
  refreshKey,
  onSelect,
}: {
  scope: string;
  shared: boolean;
  refreshKey: number;
  onSelect: (
    profile: FiscalProfile,
    version?: FiscalProfileVersionView,
  ) => void;
}) {
  const [local, setLocal] = useState<LocalFiscalProfile[]>([]),
    [remote, setRemote] = useState<FiscalProfileVersionView[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [family, setFamily] = useState<FiscalProfileVersionView | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const alive = useRef(true),
    request = useRef<AbortController | null>(null),
    liveScope = useRef(scope);
  liveScope.current = scope;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    setLocal([]);
    setRemote([]);
    setFamily(null);
    setCursor(null);
    void load(false, null);
    return () => request.current?.abort();
  }, [scope, shared, refreshKey]);
  async function load(more = false, selected = family) {
    request.current?.abort();
    const controller = new AbortController(),
      captured = scope;
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const [browser, page] = await Promise.all([
        readLocalFiscalProfiles(scope),
        shared
          ? selected
            ? fiscalApi.versions(
                selected.profileId,
                more ? (cursor ?? undefined) : undefined,
                controller.signal,
              )
            : fiscalApi.list(
                more ? (cursor ?? undefined) : undefined,
                controller.signal,
              )
          : Promise.resolve(null),
      ]);
      if (
        !alive.current ||
        liveScope.current !== captured ||
        controller.signal.aborted
      )
        return;
      setLocal(browser);
      if (page) {
        setRemote((old) =>
          more
            ? [
                ...new Map(
                  [...old, ...page.profiles].map((value) => [value.id, value]),
                ).values(),
              ]
            : page.profiles,
        );
        setCursor(page.nextCursor);
      }
    } catch (failure) {
      if (
        alive.current &&
        liveScope.current === captured &&
        !controller.signal.aborted
      )
        setError(
          failure instanceof Error
            ? failure.message
            : "The profile library is unavailable.",
        );
    } finally {
      if (alive.current && request.current === controller) setBusy(false);
    }
  }
  async function select(version: FiscalProfileVersionView) {
    request.current?.abort();
    const controller = new AbortController(),
      captured = scope;
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const result = await fiscalApi.read(
        version.profileId,
        version.id,
        controller.signal,
      );
      if (
        alive.current &&
        liveScope.current === captured &&
        !controller.signal.aborted
      )
        onSelect(result.profile, result.version);
    } catch (failure) {
      if (
        alive.current &&
        liveScope.current === captured &&
        !controller.signal.aborted
      )
        setError((failure as Error).message);
    } finally {
      if (alive.current && request.current === controller) setBusy(false);
    }
  }
  return (
    <section
      className="fiscal-section"
      aria-label="Fiscal profile library"
      aria-busy={busy}
    >
      <h3>A local starting point, kept with its evidence.</h3>
      <p>
        Profiles are immutable snapshots. Selecting one copies it into this
        draft for review; it does not change a project or its baseline.
      </p>
      {error && (
        <p role="alert" className="fiscal-error">
          {error}
        </p>
      )}
      <button
        type="button"
        className="button"
        disabled={busy}
        onClick={() => void load()}
      >
        Refresh profile library
      </button>
      <h4>Saved in this browser</h4>
      {!local.length && (
        <p className="fiscal-muted">
          No profiles saved here for this account scope.
        </p>
      )}
      {local.map((value) => (
        <article className="fiscal-library-item" key={value.hash}>
          <strong>{value.profile.name}</strong>
          <span>
            {value.profile.jurisdiction.name} · {value.profile.profileVersion} ·
            fiscal {value.profile.fiscalYear}
          </span>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => onSelect(value.profile)}
          >
            Use browser profile {value.profile.name}
          </button>
        </article>
      ))}
      <h4>
        {shared && family ? `Versions of ${family.name}` : "Workspace library"}
      </h4>
      {!shared && (
        <p className="notice">
          Browser profiles work without an account. A free workspace membership
          also enables its shared profile library; project-only access does not
          expose that library.
        </p>
      )}
      {shared && family && (
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => {
            setFamily(null);
            void load(false, null);
          }}
        >
          Back to latest profiles
        </button>
      )}
      {shared && !remote.length && !busy && (
        <p className="fiscal-muted">
          No retained workspace profiles in this view.
        </p>
      )}
      {shared &&
        remote.map((value) => (
          <article className="fiscal-library-item" key={value.id}>
            <strong>{value.name}</strong>
            <span>
              {value.jurisdictionName} · version {value.version} · fiscal{" "}
              {value.fiscalYear}
            </span>
            <div className="fiscal-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void select(value)}
              >
                Use {value.name} version {value.version}
              </button>
              {!family && (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setFamily(value);
                    void load(false, value);
                  }}
                >
                  View retained versions of {value.name}
                </button>
              )}
            </div>
          </article>
        ))}
      {shared && cursor && (
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void load(true)}
        >
          Load older fiscal profiles
        </button>
      )}
    </section>
  );
}
