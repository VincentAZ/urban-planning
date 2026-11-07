import {
  FLOOD_METHOD_VERSION,
  floodMethodVersion,
  type FloodReference,
} from "@urban/core";

export function FloodMethod({
  reference,
  onUpdate,
  disabled = false,
}: {
  reference: FloodReference;
  onUpdate?: () => void;
  disabled?: boolean;
}) {
  const method = floodMethodVersion(reference);
  const legacy = method !== FLOOD_METHOD_VERSION;
  return (
    <section className="flood-method" aria-label="Flood calculation method">
      <h3>Calculation method</h3>
      <p>
        <code>{method}</code>
        {legacy ? " · Retained legacy method" : " · Current method"}
      </p>
      {legacy && (
        <p>
          This scenario keeps its original calculation method. The source map is
          unchanged. Updating the method may change results; prior reports and
          published snapshots retain their original method.
        </p>
      )}
      {legacy && onUpdate && (
        <>
          <p>
            Update this scenario to <code>{FLOOD_METHOD_VERSION}</code>. Undo
            restores the previous method.
          </p>
          <button
            type="button"
            className="button compact"
            disabled={disabled}
            onClick={onUpdate}
          >
            Update calculation method
          </button>
        </>
      )}
    </section>
  );
}
