import { useState } from "react";
import { FileText, Save } from "lucide-react";
import type { Scenario } from "@urban/core";
import { Modal } from "./Modal";

/** Human-authored proposal text is saved as a reversible scenario revision. */
export function ScenarioDetailsDialog({
  scenario,
  readOnly,
  onSave,
  onClose,
}: {
  scenario: Scenario;
  readOnly: boolean;
  onSave: (details: { name: string; description: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(scenario.name);
  const [description, setDescription] = useState(scenario.description);
  const [error, setError] = useState("");
  return (
    <Modal
      title="Tell the proposal’s story."
      description="These notes appear in your staff report and public snapshot. Changes stay in the scenario’s revision history."
      open
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (readOnly) return;
          const cleanName = name.trim();
          if (!cleanName) {
            setError("Give this scenario a name.");
            return;
          }
          onSave({ name: cleanName, description: description.trim() });
          onClose();
        }}
      >
        <div className="report-notes-intro">
          <FileText size={20} aria-hidden="true" />
          <p>
            Explain what changes, why it matters, and what decision you want the
            reader to consider. Keep estimates and assumptions distinct from
            confirmed facts.
          </p>
        </div>
        {readOnly && (
          <p className="notice">
            {scenario.id === "baseline"
              ? "The baseline is locked. Create an alternative to describe a proposal."
              : "Your role allows you to read these notes. An editor or owner can update them."}
          </p>
        )}
        <label className="field">
          <span>Scenario name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={240}
            required
            readOnly={readOnly}
          />
        </label>
        <label className="field">
          <span>Proposal description</span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={10000}
            rows={8}
            readOnly={readOnly}
            placeholder="Describe the proposed changes, the purpose of this option, and any decisions or questions for review."
            aria-describedby="proposal-notes-help"
          />
        </label>
        <p id="proposal-notes-help" className="muted small">
          Written by your team. Saving updates this scenario; existing public
          snapshots keep their original text.
        </p>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="report-notes-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            {readOnly ? "Close" : "Cancel"}
          </button>
          {!readOnly && (
            <button
              type="submit"
              className="button primary"
              disabled={
                name.trim() === scenario.name &&
                description.trim() === scenario.description
              }
            >
              <Save size={15} /> Save proposal notes
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
