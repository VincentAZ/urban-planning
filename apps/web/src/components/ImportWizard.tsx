import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { LoaderCircle, Upload } from "lucide-react";
import type { ProjectSnapshot } from "@urban/core";
import { validateWorkspaceSnapshot } from "../lib/flood-validation";
import { Modal } from "./Modal";
import {
  ImportWorkbench,
  type ImportWorkbenchProps,
} from "./import/ImportWorkbench";
import "./import/import.css";

interface Props extends Omit<ImportWorkbenchProps, "onDirtyChange"> {
  onRestore: (snapshot: ProjectSnapshot) => Promise<void>;
}
export function ImportWizard(props: Props) {
  const [mode, setMode] = useState<"geometry" | "project">("geometry"),
    [dirty, setDirty] = useState(false);
  const [restored, setRestored] = useState<ProjectSnapshot | null>(null),
    [filename, setFilename] = useState("");
  const [error, setError] = useState(""),
    [validating, setValidating] = useState(false),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<"close" | "geometry" | "project" | null>(
      null,
    );
  const validationController = useRef<AbortController | null>(null);
  const readGeneration = useRef(0),
    keepEditing = useRef<HTMLButtonElement>(null),
    live = useRef(props);
  live.current = props;
  const pending = dirty || !!filename || busy;
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (pending) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [pending]);
  useEffect(
    () => () => {
      readGeneration.current++;
      validationController.current?.abort();
    },
    [],
  );
  function request(action: "close" | "geometry" | "project") {
    if (pending) setConfirm(action);
    else finish(action);
  }
  function finish(action: "close" | "geometry" | "project") {
    readGeneration.current++;
    validationController.current?.abort();
    setValidating(false);
    setConfirm(null);
    if (action === "close") props.onClose();
    else {
      setMode(action);
      setDirty(false);
      setRestored(null);
      setFilename("");
      setError("");
    }
  }
  async function readProject(file: File | undefined) {
    const sequence = ++readGeneration.current;
    validationController.current?.abort();
    const controller = new AbortController();
    validationController.current = controller;
    setRestored(null);
    setError("");
    setFilename(file?.name ?? "");
    setValidating(!!file);
    if (!file) return;
    try {
      if (file.size > 20 * 1024 ** 2)
        throw new Error("Please use a project JSON smaller than 20 MiB.");
      const value = await validateWorkspaceSnapshot(
        JSON.parse(await file.text()),
        controller.signal,
      );
      if (sequence === readGeneration.current) setRestored(value);
    } catch (error) {
      if (sequence === readGeneration.current)
        setError((error as Error).message);
    } finally {
      if (sequence === readGeneration.current) setValidating(false);
    }
  }
  return (
    <Modal
      title="Bring your local knowledge."
      description="Review complete geometry, attribute meanings and source rights before one reversible import."
      wide
      open
      onClose={() => request("close")}
    >
      <div className="import-mode-tabs" role="group" aria-label="Import type">
        <button
          type="button"
          aria-pressed={mode === "geometry"}
          onClick={() => mode !== "geometry" && request("geometry")}
        >
          Geographic layer
        </button>
        <button
          type="button"
          aria-pressed={mode === "project"}
          onClick={() => mode !== "project" && request("project")}
        >
          Saved project
        </button>
      </div>
      {mode === "geometry" ? (
        <ImportWorkbench {...props} onDirtyChange={setDirty} />
      ) : (
        <section className="import-section" aria-busy={validating}>
          <label className="upload-zone">
            <Upload size={28} />
            <strong>{filename || "Choose an exported project JSON"}</strong>
            <span>
              Restore a complete Urban Planning project with its captured
              baseline
            </span>
            <input
              aria-label="Exported project JSON"
              type="file"
              accept=".json"
              disabled={busy}
              onChange={(event) => void readProject(event.target.files?.[0])}
            />
          </label>
          {validating && (
            <p role="status">
              Checking the captured baseline and retained sources…
            </p>
          )}
          {restored && (
            <>
              <div className="notice">
                <strong>{restored.project.name}</strong>
                <br />
                {restored.project.scenarios.length} scenarios ·{" "}
                {restored.project.history.length} edit records. Includes its
                captured baseline from {restored.place.loadedAt}. Restores as a
                separate copy. Reopen your prior draft from “On this browser” in
                project home.
              </div>
              <button
                type="button"
                className="button primary full-width"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  const captured = live.current;
                  try {
                    await captured.onRestore(restored);
                    captured.onClose();
                  } catch (error) {
                    setError((error as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy && <LoaderCircle size={15} className="spin" />} Restore as
                a copy
              </button>
            </>
          )}
          {error && (
            <div className="error-message" role="alert">
              {error}
            </div>
          )}
        </section>
      )}
      <Dialog.Root
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay import-confirm-overlay" />
          <Dialog.Content
            className="modal import-confirm"
            role="alertdialog"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              keepEditing.current?.focus();
            }}
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setConfirm(null);
            }}
          >
            <Dialog.Title>Leave this import review?</Dialog.Title>
            <Dialog.Description>
              Unapplied form choices and local file selection will be discarded.
              Server processing already submitted continues unless you cancel
              it; use recent imports to reopen retained jobs. Applied scenario
              changes are unaffected.
            </Dialog.Description>
            <div className="import-inline-actions">
              <button
                type="button"
                className="button primary"
                ref={keepEditing}
                onClick={() => setConfirm(null)}
              >
                Keep reviewing
              </button>
              <button
                type="button"
                className="button"
                onClick={() => confirm && finish(confirm)}
              >
                Discard local choices
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Modal>
  );
}
