import {
  validateFloodInWorker,
  validateWorkspaceSnapshot,
} from "./flood-validation";
import { create } from "zustand";
import { runHousingTask } from "./housing-task";
import {
  applyCommand,
  FLOOD_METHOD_VERSION,
  floodMethodVersion,
  projectWithHousingVersion,
  projectWithImportedHousing,
  housingProjectIssues,
  type HousingIncomeLimitCatalog,
  type HousingAffordabilityScenario,
  fiscalProjectIssues,
  projectWithImportedFlood,
  type FloodDataset,
  validateParcelCommand,
  projectWithImportedTraffic,
  projectWithImportedWorkforce,
  validateWorkforceScenario,
  validateActivityScenario,
  validateRetailScenario,
  validateBuildingCommand,
  baselineIdentity as identifyBaseline,
  validatePlace,
  type BaselineIdentity,
  type ProjectSnapshot,
  type Command,
  type HistoryEntry,
  type Place,
  type Project,
  type Scenario,
} from "@urban/core";
import { createProject, createScenario, resolveActivity } from "@urban/models";

import {
  commandSchema,
  projectSchema,
} from "../../../../packages/core/src/validation";
import {
  readWorkspace,
  writeWorkspace,
  rekeyWorkspaceDraft,
} from "./workspace-storage";
import { type CloudProjectLink } from "./cloud-workspace";
const storageKey = "urban-planning:workspace:v1";
const storageMessage =
  "Browser storage is full or unavailable. Existing saved records are preserved. Keep this tab open and export your complete project.";
let initialization = 0,
  writeSequence = 0;
let loadLatest: (() => Promise<Place>) | null = null;
let storageReadFailed = false;
export interface LegacyDraft {
  raw: string;
  project: Project | null;
  currentPlace: Place;
  reason: string;
}

interface Workspace {
  place: Place | null;
  project: Project | null;
  selectedId: string | null;
  storageError: string | null;
  storagePending: boolean;
  baselineIdentity: BaselineIdentity | null;
  legacyDraft: LegacyDraft | null;
  cloudLink: CloudProjectLink | null;
  readOnly: boolean;
  readOnlyReason: string | null;
  setReadOnly: (readOnly: boolean, reason?: string) => void;
  actorName: string;
  setActorName: (name: string) => void;
  linkCloud: (link: CloudProjectLink) => Promise<void>;
  adoptCloudSave: (
    previousId: string,
    link: CloudProjectLink,
    identity: BaselineIdentity,
  ) => Promise<void>;
  resolveLegacy: (action: "adopt" | "new") => Promise<void>;
  initialize: (source: Place | (() => Promise<Place>)) => Promise<void>;
  dispatch: (command: Command, label: string) => void;
  attachFlood: (
    dataset: FloodDataset,
    expectedHash: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  updateFloodMethod: (project: Project, scenario: Scenario) => void;
  applyAffordability: (
    catalog: HousingIncomeLimitCatalog,
    affordability: HousingAffordabilityScenario,
    signal?: AbortSignal,
  ) => Promise<void>;
  undo: () => void;
  redo: () => void;
  select: (id: string | null) => void;
  activate: (id: string) => void;
  branch: (name?: string) => void;
  replace: (
    project: Project,
    place: Place,
    identity?: BaselineIdentity,
    cloudLink?: CloudProjectLink,
  ) => Promise<void>;
  reset: () => Promise<void>;
  restoreCopy: (snapshot: ProjectSnapshot) => Promise<void>;
}
function edited(project: Project, scenario: Scenario): Project {
  return {
    ...project,
    scenarios: project.scenarios.map((s) =>
      s.id === scenario.id ? scenario : s,
    ),
    updatedAt: scenario.updatedAt,
  };
}
export const useWorkspace = create<Workspace>((set, get) => {
  let changingSnapshot = false;
  const persist = (project: Project) => {
    const { place, baselineIdentity, cloudLink } = get();
    if (!place || !baselineIdentity) return;
    if (storageReadFailed) {
      set({
        storagePending: false,
        storageError:
          "The previous browser draft could not be read. This is a temporary new session; saved records have not been overwritten. Export your work before closing.",
      });
      return;
    }
    const sequence = ++writeSequence;
    set({ storagePending: true });
    void writeWorkspace({
      project,
      place,
      baselineIdentity,
      ...(cloudLink ? { cloudLink } : {}),
    })
      .then(() => {
        if (sequence === writeSequence)
          set({ storagePending: false, storageError: null });
      })
      .catch(() => {
        if (sequence === writeSequence)
          set({ storagePending: false, storageError: storageMessage });
      });
  };
  const commit = (command: Command, label: string, project = get().project) => {
    if (changingSnapshot || get().readOnly) return;
    if (!project) return;
    const scenario = project.scenarios.find(
      (s) => s.id === project.activeScenarioId,
    );
    if (!scenario || scenario.id === "baseline") return;
    if (
      command.type.startsWith("parcel.") ||
      command.type.startsWith("parcels.") ||
      command.type.startsWith("building.") ||
      command.type.startsWith("buildings.") ||
      command.type.startsWith("road.") ||
      command.type === "scenario.presentation" ||
      command.type === "scenario.activity" ||
      command.type === "scenario.retail" ||
      command.type === "scenario.workforce" ||
      command.type === "scenario.traffic" ||
      command.type === "scenario.flood" ||
      command.type === "scenario.fiscal" ||
      command.type === "scenario.affordability"
    )
      command = commandSchema.parse(command) as Command;
    if (get().place) {
      validateParcelCommand(get().place!, scenario, command);
      validateBuildingCommand(get().place!, scenario, command);
      if (command.type === "scenario.activity" && command.activity)
        validateActivityScenario(command.activity, get().place!, [
          ...(scenario.sources ?? []),
          ...(command.sources ?? []),
        ]);
      if (command.type === "scenario.retail" && command.retail)
        validateRetailScenario(command.retail, get().place!, [
          ...(scenario.sources ?? []),
          ...(command.sources ?? []),
        ]);
      if (command.type === "scenario.workforce" && command.workforce) {
        validateWorkforceScenario(command.workforce, get().place!);
        if (
          command.workforce.binding.baselineHash !==
          get().baselineIdentity?.sha256
        )
          throw new Error(
            "The workforce capture belongs to a different immutable baseline.",
          );
      }
      if (
        command.type === "scenario.traffic" &&
        command.traffic &&
        (command.traffic.binding.placeId !== get().place!.id ||
          command.traffic.binding.baselineHash !==
            get().baselineIdentity?.sha256)
      )
        throw new Error(
          "The traffic capture belongs to a different immutable baseline.",
        );
    }
    const after = applyCommand(scenario, command);
    if (after.activity && get().place) resolveActivity(get().place!, after);
    const entry: HistoryEntry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      actor: get().actorName,
      label,
      command,
      before: structuredClone(scenario),
      after: structuredClone(after),
    };
    const supersededIds = new Set(
      project.undone.filter((e) => e.after.id === scenario.id).map((e) => e.id),
    );
    const next = projectWithHousingVersion(
      {
        ...edited(project, after),
        history: [
          ...project.history.map((e) =>
            supersededIds.has(e.id) ? { ...e, superseded: true } : e,
          ),
          entry,
        ],
        undone: project.undone.filter((e) => e.after.id !== scenario.id),
      },
      get().place ?? undefined,
    );
    if (command.type === "scenario.fiscal") {
      const issues = fiscalProjectIssues(next, get().place ?? undefined);
      if (issues.length) throw new Error(issues.join(" "));
    }
    if (command.type === "scenario.affordability") {
      const issues = housingProjectIssues(next);
      if (issues.length) throw new Error(issues.join(" "));
    }
    set({ project: next });
    persist(next);
  };
  return {
    place: null,
    project: null,
    selectedId: null,
    storageError: null,
    storagePending: false,
    baselineIdentity: null,
    legacyDraft: null,
    cloudLink: null,
    readOnly: false,
    readOnlyReason: null,
    actorName: "Anonymous browser",
    setActorName(actorName) {
      set({ actorName: actorName.slice(0, 240) });
    },
    setReadOnly(readOnly, reason) {
      set({
        readOnly,
        readOnlyReason: readOnly
          ? (reason ?? "This saved project is open for review.")
          : null,
      });
    },
    async linkCloud(cloudLink) {
      const { project, place, baselineIdentity } = get();
      if (
        !project ||
        !place ||
        !baselineIdentity ||
        cloudLink.projectId !== project.id
      )
        throw new Error(
          "The account connection does not match the current draft.",
        );
      set({ cloudLink });
      await writeWorkspace({ project, place, baselineIdentity, cloudLink });
    },
    async adoptCloudSave(previousId, cloudLink, identity) {
      if (changingSnapshot)
        throw new Error("Wait for the current project to finish opening.");
      const current = get();
      const { project, place, baselineIdentity } = current;
      if (
        !project ||
        !place ||
        !baselineIdentity ||
        current.cloudLink ||
        project.id !== previousId ||
        cloudLink.projectId === previousId ||
        identity.sha256 !== baselineIdentity.sha256
      )
        throw new Error(
          "The cloud save no longer matches this anonymous draft and its captured source.",
        );
      changingSnapshot = true;
      ++writeSequence;
      const adopted = { ...project, id: cloudLink.projectId };
      set({ storagePending: true });
      try {
        await rekeyWorkspaceDraft(previousId, {
          project: adopted,
          place,
          baselineIdentity,
          cloudLink,
        });
        storageReadFailed = false;
        // This is an authenticated save acknowledgment, not a restored snapshot.
        // Keep the current selection, permissions and geometry references intact.
        set({
          project: adopted,
          cloudLink,
          storagePending: false,
          storageError: null,
        });
      } catch (error) {
        set({ storagePending: false, storageError: storageMessage });
        throw error;
      } finally {
        changingSnapshot = false;
      }
    },
    async initialize(source) {
      const generation = ++initialization;
      loadLatest = typeof source === "function" ? source : async () => source;
      // A captured draft opens without requesting the current catalog at all.
      let restored,
        readFailed = false;
      try {
        restored = await readWorkspace();
      } catch {
        readFailed = true;
      }
      if (generation !== initialization) return;
      storageReadFailed = readFailed;
      if (restored) {
        set({
          ...restored,
          cloudLink: restored.cloudLink ?? null,
          readOnly: !!restored.cloudLink,
          readOnlyReason: restored.cloudLink
            ? "Checking access to this saved project…"
            : null,
          legacyDraft: null,
          selectedId: null,
          storageError: null,
          storagePending: false,
        });
        return;
      }
      const place = validatePlace(await loadLatest());
      if (generation !== initialization) return;
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(storageKey);
      } catch {
        /* IndexedDB remains usable; no legacy records are overwritten. */
      }
      if (raw) {
        let project: Project | null = null;
        try {
          const parsed = projectSchema.safeParse(JSON.parse(raw));
          if (parsed.success) project = parsed.data as Project;
        } catch {}
        set({
          place: null,
          project: null,
          baselineIdentity: null,
          legacyDraft: {
            raw,
            project,
            currentPlace: place,
            reason:
              "This older draft did not capture its baseline. Its original source cannot be reconstructed. Your original draft is preserved until you choose how to continue.",
          },
        });
        return;
      }
      const project = createProject(place),
        identity = await identifyBaseline(place);
      if (generation !== initialization) return;
      set({
        place,
        project,
        baselineIdentity: identity,
        legacyDraft: null,
        selectedId: null,
        storageError: null,
        cloudLink: null,
        readOnly: false,
        readOnlyReason: null,
      });
      persist(project);
    },
    async resolveLegacy(action) {
      const legacy = get().legacyDraft;
      if (!legacy) return;
      let project =
        action === "new" ? createProject(legacy.currentPlace) : legacy.project;
      if (!project)
        throw new Error(
          "This legacy draft cannot be safely migrated. Download the original for recovery, then start a new project.",
        );
      if (action === "adopt")
        project = {
          ...project,
          baselineMigration: {
            kind: "legacy-source-adoption",
            adoptedAt: new Date().toISOString(),
            message:
              "The original draft did not contain a baseline snapshot. The user explicitly adopted the then-current source while preserving scenario edits; earlier results cannot be reconstructed.",
          },
        };
      await get().replace(project, legacy.currentPlace);
      set({ legacyDraft: null });
    },
    select(selectedId) {
      set({ selectedId });
    },
    dispatch(command, label) {
      commit(command, label);
    },
    async attachFlood(dataset, expectedHash, signal) {
      const current = get();
      if (
        changingSnapshot ||
        current.readOnly ||
        !current.project ||
        current.project.activeScenarioId === "baseline" ||
        !current.place
      )
        throw new Error("This project is not editable.");
      const project = await validateFloodInWorker(
        {
          type: "attach",
          project: current.project,
          dataset,
          place: current.place,
          expectedHash,
        },
        signal,
      );
      signal?.throwIfAborted();
      if (
        get().project !== current.project ||
        get().place !== current.place ||
        get().readOnly ||
        changingSnapshot
      )
        throw new Error(
          "The project changed while the flood map was being checked. Review it again.",
        );
      if (!project.floodDatasets?.[expectedHash])
        throw new Error("The flood map does not match its published identity.");
      commit(
        {
          type: "scenario.flood",
          flood: {
            version: 1,
            datasetHash: expectedHash,
            origin: "server-catalog",
            methodVersion: FLOOD_METHOD_VERSION,
          },
        },
        "Attach captured flood map",
        project,
      );
    },
    async applyAffordability(catalog, affordability, signal) {
      const current = get();
      if (
        changingSnapshot ||
        current.readOnly ||
        !current.project ||
        !current.place ||
        current.project.activeScenarioId === "baseline"
      )
        throw new Error("This project is not editable.");
      const project = await runHousingTask<Project>(
        {
          kind: "apply",
          place: current.place,
          project: current.project,
          catalog,
          affordability,
        },
        signal,
      );
      signal?.throwIfAborted();
      if (
        get().project !== current.project ||
        get().place !== current.place ||
        get().readOnly ||
        changingSnapshot
      )
        throw new Error(
          "The project changed while housing evidence was being prepared. Review it again.",
        );
      commit(
        { type: "scenario.affordability", affordability },
        "Apply reviewed housing affordability",
        project,
      );
    },
    updateFloodMethod(expectedProject, expectedScenario) {
      const current = get();
      if (
        changingSnapshot ||
        current.readOnly ||
        current.project !== expectedProject ||
        expectedProject.activeScenarioId !== expectedScenario.id ||
        expectedScenario.id === "baseline" ||
        !expectedProject.scenarios.includes(expectedScenario) ||
        !expectedScenario.flood
      )
        throw new Error(
          "The project or editing access changed. Review the flood method again.",
        );
      if (floodMethodVersion(expectedScenario.flood) === FLOOD_METHOD_VERSION)
        return;
      commit(
        {
          type: "scenario.flood",
          flood: {
            ...expectedScenario.flood,
            methodVersion: FLOOD_METHOD_VERSION,
          },
        },
        "Update flood calculation method",
      );
    },
    undo() {
      if (changingSnapshot || get().readOnly) return;
      const { project } = get();
      if (!project) return;
      const entries = project.history.filter(
        (e) =>
          e.after.id === project.activeScenarioId &&
          !e.superseded &&
          !project.undone.some((u) => u.id === e.id),
      );
      const entry = entries.at(-1);
      if (!entry) return;
      const current = project.scenarios.find((s) => s.id === entry.after.id)!;
      const scenario = {
        ...structuredClone(entry.before),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const next = {
        ...edited(project, scenario),
        undone: [...project.undone, entry],
      };
      set({ project: next });
      persist(next);
    },
    redo() {
      if (changingSnapshot || get().readOnly) return;
      const { project } = get();
      if (!project) return;
      const entry = project.undone
        .filter((e) => e.after.id === project.activeScenarioId)
        .at(-1);
      if (!entry) return;
      const current = project.scenarios.find((s) => s.id === entry.after.id)!;
      const scenario = {
        ...structuredClone(entry.after),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      const next = {
        ...edited(project, scenario),
        undone: project.undone.filter((e) => e.id !== entry.id),
      };
      set({ project: next });
      persist(next);
    },
    activate(id) {
      if (changingSnapshot) return;
      const { project } = get();
      if (!project || !project.scenarios.some((s) => s.id === id)) return;
      const next = { ...project, activeScenarioId: id };
      set({ project: next, selectedId: null });
      persist(next);
    },
    branch(name) {
      if (changingSnapshot || get().readOnly) return;
      const { project } = get();
      if (!project) return;
      const parent = project.scenarios.find(
        (s) => s.id === project.activeScenarioId,
      )!;
      const scenario = createScenario(
        name ||
          `Option ${String.fromCharCode(65 + project.scenarios.filter((s) => s.id !== "baseline").length)}`,
        parent,
      );
      const next = {
        ...project,
        scenarios: [...project.scenarios, scenario],
        activeScenarioId: scenario.id,
        updatedAt: new Date().toISOString(),
      };
      set({ project: next });
      persist(next);
    },
    async replace(project, place, identity, cloudLink) {
      if (changingSnapshot)
        throw new Error("Wait for the current project to finish opening.");
      changingSnapshot = true;
      try {
        const snapshot = await validateWorkspaceSnapshot({
          project,
          place,
          baselineIdentity: identity,
        });
        set({ storagePending: true });
        await writeWorkspace({ ...snapshot, cloudLink });
        ++writeSequence;
        storageReadFailed = false;
        set({
          ...snapshot,
          cloudLink: cloudLink ?? null,
          readOnly: !!cloudLink,
          readOnlyReason: cloudLink
            ? "Checking access to this saved project…"
            : null,
          selectedId: null,
          legacyDraft: null,
          storagePending: false,
          storageError: null,
        });
      } catch (error) {
        set({ storagePending: false, storageError: storageMessage });
        throw error;
      } finally {
        changingSnapshot = false;
      }
    },
    async restoreCopy(snapshot) {
      const project = {
        ...projectWithImportedTraffic(
          projectWithImportedFlood(
            projectWithImportedHousing(
              projectWithImportedWorkforce(snapshot.project),
            ),
          ),
        ),
        id: crypto.randomUUID(),
        name: `${snapshot.project.name.slice(0, 220)} · restored copy`,
        updatedAt: new Date().toISOString(),
      };
      await get().replace(project, snapshot.place, snapshot.baselineIdentity);
    },
    async reset() {
      if (!loadLatest) return;
      const place = validatePlace(await loadLatest());
      await get().replace(createProject(place), place);
    },
  };
});
