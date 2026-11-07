import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  trafficContentHash,
  trafficSignalProgramHash,
  trafficSignalEditablePhase,
  type TrafficVehicle,
  type TrafficCount,
} from "@urban/core";
import {
  TrafficRuntime,
  SUMO_IMAGE,
  type PreparedTrafficNetwork,
  type TrafficNativePairRequest,
} from "./index.js";
import { assertNativeSignalTimings } from "./signal-effects.js";
import {
  runTrafficExperiment,
  type TrafficExperimentRequest,
} from "./experiment.js";

const sha = (raw: string | Buffer) =>
  createHash("sha256").update(raw).digest("hex");
// Synthetic source geometry exercises actual pinned netconvert and SUMO binaries.
// It is a test fixture, not an observed or calibrated traffic demonstration.
const osm = `<osm version="0.6" generator="urban-test">
<node id="1" lat="33.0000" lon="-112.0030"/><node id="2" lat="33.0000" lon="-112.0020"/>
<node id="3" lat="33.0000" lon="-112.0000"><tag k="highway" v="traffic_signals"/></node><node id="4" lat="33.0020" lon="-112.0010"/>
<node id="5" lat="33.0000" lon="-111.9980"/><node id="6" lat="33.0000" lon="-111.9970"/>
<node id="7" lat="32.9990" lon="-112.0000"/><node id="8" lat="33.0030" lon="-112.0010"/>
${[
  [5, [1, 2]],
  [10, [2, 3]],
  [11, [3, 5]],
  [20, [2, 4]],
  [21, [4, 5]],
  [30, [5, 6]],
  [40, [3, 7]],
  [41, [4, 8]],
]
  .map(
    ([id, ns]) =>
      `<way id="${id}">${(ns as number[]).map((n) => `<nd ref="${n}"/>`).join("")}<tag k="highway" v="residential"/><tag k="oneway" v="yes"/><tag k="lanes" v="1"/><tag k="maxspeed" v="30"/></way>`,
  )
  .join("")}
</osm>`;
const source = {
  id: "test-osm",
  name: "Synthetic native traffic test",
  url: "https://example.test/fixture.osm",
  vintage: "2026",
  license: "CC0 test fixture",
  kind: "user-supplied" as const,
  description: "Synthetic test topology only.",
};

describe.skipIf(process.env.RUN_NATIVE_TRAFFIC_TESTS !== "1")(
  "pinned native traffic sandbox",
  () => {
    let root: string, runtime: TrafficRuntime, network: PreparedTrafficNetwork;
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "urban-traffic-test-"));
      runtime = new TrafficRuntime({
        workRoot: join(root, "work"),
        allowedInputRoot: root,
      });
      await writeFile(join(root, "source.osm.xml"), osm);
      network = await runtime.prepareNetwork({
        osmXmlPath: join(root, "source.osm.xml"),
        osmXmlSha256: sha(osm),
        bounds: [-112.004, 32.999, -111.996, 33.003],
        sources: [source],
        sourceFiles: [
          {
            sourceId: source.id,
            url: source.url,
            sha256: sha(osm),
            bytes: Buffer.byteLength(osm),
            retrievedAt: "2026-11-06T00:00:00Z",
          },
        ],
      });
    }, 30000);
    afterAll(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });
    const request = async (): Promise<TrafficNativePairRequest> => {
      const edge = (way: string) =>
        network.network.edges.find((e) => e.sourceWayIds.includes(way))!.id;
      const route = ["5", "10", "11", "30"].map(edge);
      const vehicles: TrafficVehicle[] = Array.from({ length: 20 }, (_, i) => ({
        id: `vehicle-${i}`,
        odId: "od-1",
        routeId: "route-1",
        departSeconds: i * 5,
        edges: route,
        vehicleClass: "passenger",
      }));
      const counts: TrafficCount[] = [
        {
          id: "count-1",
          stationId: "synthetic",
          position: null,
          date: "2026-11-06",
          timeZone: "America/Phoenix",
          utcOffsetMinutes: -420,
          beginSeconds: 0,
          endSeconds: 300,
          value: 20,
          status: "available",
          kind: "observed",
          target: { kind: "edge", edgeId: edge("30"), positionFraction: 0.5 },
          mapping: {
            networkFileSha256: network.network.manifest.networkFileSha256,
            method: "manual",
            snapMeters: null,
            directionAgreement: "confirmed",
            reviewedBy: "test",
            reviewedAt: "2026-11-06T00:00:00Z",
          },
          vehicleClasses: ["passenger"],
          raw: {
            directionCode: "test",
            laneCode: "all",
            classCode: "passenger",
            recordId: "test1",
            value: "20",
          },
          sourceIds: [source.id],
          notes: ["Synthetic test count, not field evidence."],
        },
      ];
      return {
        network,
        period: {
          date: "2026-11-06",
          timeZone: "America/Phoenix",
          utcOffsetMinutes: -420,
          beginSeconds: 0,
          endSeconds: 300,
          warmupSeconds: 0,
          cooldownSeconds: 100,
        },
        seed: 13,
        vehicles,
        counts,
        overlays: [],
        demandHash: await trafficContentHash(vehicles),
        countPackHash: await trafficContentHash(counts),
      };
    };
    it("uses the pinned engine and complete directed source topology", () => {
      expect(network.network.manifest.engine.imageDigest).toBe(
        SUMO_IMAGE.split("@")[1],
      );
      expect(network.network.manifest.engine.version).toBe("1.26.0");
      expect(network.network.edges).toHaveLength(8);
      expect(network.network.connections.length).toBeGreaterThan(4);
      expect(sha(network.networkXml)).toBe(
        network.network.manifest.networkFileSha256,
      );
    });
    it("retains original-way IDs stored on joined native lanes in new v2 inventories", async () => {
      const joined = osm
        .replace(
          '<node id="1"',
          '<node id="9" lat="33.0000" lon="-112.0025"/><node id="1"',
        )
        .replace(
          /<way id="5">.*?<\/way>/,
          '<way id="5"><nd ref="1"/><nd ref="9"/><tag k="highway" v="residential"/><tag k="oneway" v="yes"/><tag k="lanes" v="1"/><tag k="maxspeed" v="30"/></way><way id="50"><nd ref="9"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="oneway" v="yes"/><tag k="lanes" v="1"/><tag k="maxspeed" v="30"/></way>',
        );
      const path = join(root, "joined.osm.xml");
      await writeFile(path, joined);
      const prepared = await runtime.prepareNetwork({
        osmXmlPath: path,
        osmXmlSha256: sha(joined),
        bounds: [-112.004, 32.999, -111.996, 33.003],
        sources: [source],
        sourceFiles: [
          {
            sourceId: source.id,
            url: source.url,
            sha256: sha(joined),
            bytes: Buffer.byteLength(joined),
            retrievedAt: "2026-11-06T00:00:00Z",
          },
        ],
      });
      expect(prepared.network.manifest.conversion.version).toMatch(
        /^urban-traffic-net-2:/,
      );
      expect(
        prepared.network.edges.some(
          (edge) =>
            edge.sourceWayIds.includes("5") && edge.sourceWayIds.includes("50"),
        ),
      ).toBe(true);
      expect(prepared.network.manifest.conversion.options.slice(-2)).toEqual([
        "--precision",
        "6",
      ]);
      // Reproduce the old inventory contract on the same synthetic native XML:
      // v1 did not read lane-level origId unions. It remains executable as v1.
      const legacy = {
        ...prepared,
        network: structuredClone(prepared.network),
      };
      legacy.network.manifest.conversion.version =
        legacy.network.manifest.conversion.version.replace(
          "urban-traffic-net-2:",
          "urban-traffic-net-1:",
        );
      for (const edge of legacy.network.edges)
        edge.sourceWayIds = [edge.id.replace(/^-/, "").split("#")[0]];
      const legacyInput = await request();
      legacyInput.network = legacy;
      legacyInput.counts = [];
      legacyInput.countPackHash = await trafficContentHash([]);
      expect(
        (await runtime.runPair(legacyInput)).baseline.diagnostics.arrived,
      ).toBe(20);
    }, 30000);
    it("runs actual paired SUMO, conserves all vehicles and predicts a native detector count", async () => {
      const result = await runtime.runPair(await request());
      expect(result.baseline.diagnostics).toMatchObject({
        requested: 20,
        loaded: 20,
        inserted: 20,
        arrived: 20,
        running: 0,
        waiting: 0,
        discarded: 0,
        teleports: 0,
        collisions: 0,
      });
      expect(result.baseline.trips).toEqual(result.proposal.trips);
      expect(result.baseline.predictions[0]).toMatchObject({
        vehicles: 20,
        status: "available",
      });
      expect(result.files["baseline-routes.xml"].length).toBeGreaterThan(100);
      expect(result.resources.peakMemoryBytes).toBeGreaterThan(0);
      // Executed floating-car tracks for map playback, raw FCD discarded.
      expect(result.files["baseline-fcd.xml"]).toBeUndefined();
      const tracks = JSON.parse(result.files["proposal-tracks.json"].toString());
      expect(tracks).toMatchObject({ version: 1, side: "proposal", stepSeconds: 2 });
      expect(tracks.vehicles.length).toBeGreaterThan(0);
      for (const vehicle of tracks.vehicles) {
        expect(vehicle.lonlat).toHaveLength(vehicle.angle.length * 2);
        expect(Math.abs(vehicle.lonlat[0])).toBeLessThanOrEqual(180);
        expect(Math.abs(vehicle.lonlat[1])).toBeLessThanOrEqual(90);
      }
    }, 30000);
    it("applies explicit service passenger inference while retaining restrictive access and native connectors", async () => {
      const cases = [
        ["service", ""],
        ["service", '<tag k="motorcar" v="no"/>'],
        ["service", '<tag k="motor_vehicle" v="no"/>'],
        ["service", '<tag k="access" v="private"/>'],
        ["service", '<tag k="access" v="no"/>'],
        ["service", '<tag k="access:conditional" v="yes @ (Mo-Fr)"/>'],
        ["residential", '<tag k="access" v="private"/>'],
        ["service", '<tag k="access" v="no"/><tag k="motorcar" v="yes"/>'],
        ["service", '<tag k="service" v="emergency_access"/>'],
        ["service", ""],
      ];
      const extraNodes = cases
        .map(
          (_, index) =>
            `<node id="${200 + index}" lat="${33.004 + index * 0.001}" lon="-111.997"><tag k="barrier" v="${index === 9 ? "gate" : "no"}"/></node>`,
        )
        .join("");
      const additions = cases
        .map(
          ([highway, tags], index) =>
            `<way id="${200 + index}"><nd ref="6"/><nd ref="${200 + index}"/><tag k="highway" v="${highway}"/><tag k="oneway" v="yes"/><tag k="maxspeed" v="30"/>${tags}</way>`,
        )
        .join("");
      const sourceXML = osm
        .replace(
          '<way id="5"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/>',
          '<way id="5"><nd ref="1"/><nd ref="2"/><tag k="highway" v="service"/>',
        )
        .replace('<way id="5">', extraNodes + '<way id="5">')
        .replace("</osm>", additions + "</osm>");
      const path = join(root, "service.osm.xml");
      await writeFile(path, sourceXML);
      const prepared = await runtime.prepareNetwork({
        osmXmlPath: path,
        osmXmlSha256: sha(sourceXML),
        bounds: [-112.004, 32.999, -111.996, 33.02],
        sources: [source],
        sourceFiles: [
          {
            sourceId: source.id,
            url: source.url,
            sha256: sha(sourceXML),
            bytes: Buffer.byteLength(sourceXML),
            retrievedAt: "2026-11-06T00:00:00Z",
          },
        ],
        serviceRoadPolicy: "infer-unrestricted-service-passenger",
      });
      const edgesForWay = (way: string) =>
        prepared.network.edges.filter((edge) =>
          edge.sourceWayIds.includes(way),
        );
      expect(
        edgesForWay("200").some((edge) =>
          edge.lanes.some((lane) => lane.allowedClasses.includes("passenger")),
        ),
      ).toBe(true);
      for (let index = 1; index < cases.length; index++)
        expect(
          edgesForWay(String(200 + index)).every((edge) =>
            edge.lanes.every(
              (lane) => !lane.allowedClasses.includes("passenger"),
            ),
          ),
        ).toBe(true);
      expect(edgesForWay("5")[0].lanes[0].allowedClasses).toContain(
        "passenger",
      );
      expect(edgesForWay("5")[0].lanes[0].speedMps).toBeCloseTo(30 / 3.6, 5);
      expect(
        JSON.parse(
          prepared.files["applied-access-policy.json"].toString(),
        ).changes.some(
          (change: { sourceWayIds: string[]; action: string }) =>
            change.sourceWayIds.includes("206") && change.action === "deny",
        ),
      ).toBe(true);
      const input = await request();
      input.network = prepared;
      input.counts = [];
      input.countPackHash = await trafficContentHash([]);
      const result = await runtime.runPair(input);
      expect(result.baseline.diagnostics).toMatchObject({
        requested: 20,
        arrived: 20,
        discarded: 0,
        teleports: 0,
        routeErrors: 0,
      });
      expect(result.proposal.trips).toEqual(result.baseline.trips);
    }, 30000);
    it("executes exact partial-edge lane positions through route serialization after a spur closure", async () => {
      const input = await request();
      input.vehicles = input.vehicles.slice(0, 3);
      const first = network.network.edges.find(
        (edge) => edge.id === input.vehicles[0].edges[0],
      )!.lanes[0];
      const last = network.network.edges.find(
        (edge) => edge.id === input.vehicles[0].edges.at(-1),
      )!.lanes[0];
      for (const vehicle of input.vehicles)
        vehicle.endpoints = {
          departLaneId: first.id,
          departPositionMeters: 25.125,
          arrivalLaneId: last.id,
          arrivalPositionMeters: 40.25,
        };
      // Closing this spur invokes duarouter without reshaping the attachment edges.
      input.overlays = [
        {
          edgeId: network.network.edges.find((edge) =>
            edge.sourceWayIds.includes("41"),
          )!.id,
          closed: true,
        },
      ];
      input.demandHash = await trafficContentHash(input.vehicles);
      const result = await runtime.runPair(input);
      for (const side of ["baseline", "proposal"] as const) {
        expect(result[side].diagnostics).toMatchObject({
          requested: 3,
          arrived: 3,
          running: 0,
          waiting: 0,
          discarded: 0,
          teleports: 0,
          collisions: 0,
        });
        const trips = result.files[`${side}-trips.xml`].toString("utf8");
        expect(trips.match(/departPos="25\.125000"/g)).toHaveLength(3);
        expect(trips.match(/arrivalPos="40\.250000"/g)).toHaveLength(3);
      }
      expect(result.files["proposal-assigned.rou.xml"].toString()).toContain(
        'departPos="25.125000"',
      );
      expect(
        JSON.parse(result.files["native-settings.json"].toString())
          .endpointPolicy,
      ).toBe("explicit-native-lanes-and-front-positions");
      // Closing the first interior route edge reshapes the adjacent attachment
      // lane in this synthetic net. Reject that change instead of relocating it.
      input.overlays = [{ edgeId: input.vehicles[0].edges[1], closed: true }];
      await expect(runtime.runPair(input)).rejects.toThrow(
        /removed or moved an explicit route attachment/,
      );
    }, 30000);
    it("rejects a control deleting an explicit attachment before native execution", async () => {
      const input = await request(),
        vehicle = input.vehicles[0];
      input.vehicles = [vehicle];
      vehicle.endpoints = {
        departLaneId: network.network.edges.find(
          (edge) => edge.id === vehicle.edges[0],
        )!.lanes[0].id,
        departPositionMeters: 10,
        arrivalLaneId: network.network.edges.find(
          (edge) => edge.id === vehicle.edges.at(-1),
        )!.lanes[0].id,
        arrivalPositionMeters: 20,
      };
      input.overlays = [{ edgeId: vehicle.edges[0], closed: true }];
      await expect(runtime.runPair(input)).rejects.toThrow(
        /removes an explicit route attachment/,
      );
    }, 30000);
    it("runs the real experiment wrapper from explicit demand through native evidence and archive payload", async () => {
      const input = await request(),
        edges = input.vehicles[0].edges;
      const experiment: TrafficExperimentRequest = {
        version: 1,
        networkHash: network.network.manifest.networkFileSha256,
        countPack: {
          version: 1,
          id: "synthetic-counts",
          sources: [source],
          files: [],
          counts: [
            ...input.counts,
            {
              ...input.counts[0],
              id: "classes-unresolved",
              vehicleClasses: null,
            },
          ],
          annualCounts: [],
          notes: [
            "Synthetic native integration fixture; not observed field traffic.",
          ],
        },
        demand: {
          version: 1,
          rows: [
            {
              id: "od-1",
              originEdge: edges[0],
              destinationEdge: edges.at(-1)!,
              beginSeconds: 0,
              endSeconds: 100,
              vehicleClass: "passenger",
              vehicles: 20,
              purpose: "unspecified",
              quality: "authored",
              sourceIds: [source.id],
            },
          ],
          candidateRoutes: [
            {
              id: "route-1",
              odId: "od-1",
              edges,
              weight: 1,
              sourceIds: [source.id],
            },
          ],
          sources: [source],
          notes: ["Explicit synthetic demand."],
        },
        period: input.period,
        seed: input.seed,
        overlays: [],
        calibrationPlan: null,
        unsupportedChanges: [],
      };
      const { capture, files } = await runTrafficExperiment(
        network,
        experiment,
        runtime,
      );
      expect(capture.allocation.vehicleCount).toBe(20);
      expect(capture.calibration).toBeNull();
      expect(capture.countSelection.selectedIds).toEqual([
        "count-1",
        "classes-unresolved",
      ]);
      expect(
        capture.baseline.predictions.find(
          (c) => c.countId === "classes-unresolved",
        ),
      ).toMatchObject({ vehicles: null, status: "unavailable" });
      expect(capture.baseline.demandHash).toBe(capture.proposal.demandHash);
      expect(capture.baseline.diagnostics.arrived).toBe(20);
      expect(capture.sources.map((s) => s.id)).toContain(source.id);
      expect(
        JSON.parse(files["experiment.json"].toString()).request.countPack.id,
      ).toBe("synthetic-counts");
      expect(files["baseline-network.json"]).toEqual(
        files["proposal-network.json"],
      );
      expect(files["baseline-trips.xml"].length).toBeGreaterThan(100);
    }, 30000);
    it("applies a reviewed static program using native tllogic patch and verifies executed signal states", async () => {
      // Add an independent crossing approach so a changed green hold can affect these vehicles.
      const crossing = osm.replace(
        "</osm>",
        '<way id="50"><nd ref="7"/><nd ref="3"/><tag k="highway" v="residential"/><tag k="oneway" v="yes"/><tag k="lanes" v="1"/><tag k="maxspeed" v="30"/></way></osm>',
      );
      await writeFile(join(root, "crossing.osm.xml"), crossing);
      const retained = await runtime.prepareNetwork({
        osmXmlPath: join(root, "crossing.osm.xml"),
        osmXmlSha256: sha(crossing),
        bounds: [-112.004, 32.999, -111.996, 33.003],
        sources: [source],
        sourceFiles: [
          {
            sourceId: source.id,
            url: source.url,
            sha256: sha(crossing),
            bytes: Buffer.byteLength(crossing),
            retrievedAt: "2026-11-06T00:00:00Z",
          },
        ],
      });
      const input = await request();
      input.network = retained;
      input.counts = input.counts.map((count) => ({
        ...count,
        mapping: {
          ...count.mapping!,
          networkFileSha256: retained.network.manifest.networkFileSha256,
        },
      }));
      const program = retained.network.signals.find((signal) =>
        signal.nodeIds.includes("3"),
      )!;
      expect(program).toBeDefined();
      const durations = program.phases.map((phase) =>
        trafficSignalEditablePhase(phase)
          ? Math.max(1, Math.round(phase.durationSeconds / 3))
          : phase.durationSeconds,
      );
      input.signalTimings = [
        {
          signalId: program.id,
          programId: program.programId,
          baselineProgramHash: await trafficSignalProgramHash(program),
          phaseDurationsSeconds: durations,
          offsetSeconds: 5,
          rationale:
            "Synthetic crossing-demand timing effect; no field calibration claim.",
        },
      ];
      const frozen = sha(retained.networkXml);
      const result = await runtime.runPair(input);
      expect(
        result.proposalNetwork.signals.find(
          (signal) => signal.id === program.id,
        ),
      ).toMatchObject({
        quality: "authored",
        offsetSeconds: 5,
        phases: program.phases.map((phase, index) => ({
          ...phase,
          durationSeconds: durations[index],
        })),
      });
      expect(result.files["signal-timing.tll.xml"].toString()).toContain(
        "<tlLogic",
      );
      expect(result.files["baseline-signal-0.xml"].toString()).toContain(
        "<tlsState",
      );
      expect(result.files["proposal-signal-0.xml"].toString()).toContain(
        "<tlsState",
      );
      expect(
        result.proposal.trips.map((trip) => trip.durationSeconds),
      ).not.toEqual(result.baseline.trips.map((trip) => trip.durationSeconds));
      expect(result.proposal.demandHash).toBe(result.baseline.demandHash);
      expect(result.proposal.trips.map((trip) => trip.id)).toEqual(
        result.baseline.trips.map((trip) => trip.id),
      );
      expect(sha(retained.networkXml)).toBe(frozen);
      const altered = structuredClone(input.signalTimings);
      altered[0].baselineProgramHash = "0".repeat(64);
      await expect(
        runtime.runPair({ ...input, signalTimings: altered }),
      ).rejects.toThrow(/hash/);
      const dynamic = {
        ...retained,
        network: structuredClone(retained.network),
        networkXml: Buffer.from(
          retained.networkXml
            .toString()
            .replace('type="static"', 'type="actuated"'),
        ),
      };
      dynamic.network.manifest.networkFileSha256 = sha(dynamic.networkXml);
      await expect(
        assertNativeSignalTimings(dynamic, input.signalTimings),
      ).rejects.toThrow(/simple static/);
    }, 30000);
    it("applies a native speed overlay while preserving the demand and frozen baseline", async () => {
      const input = await request(),
        before = sha(network.networkXml);
      input.overlays = [{ edgeId: input.vehicles[0].edges[1], speedMps: 2 }];
      const result = await runtime.runPair(input);
      expect(result.proposal.networkHash).not.toBe(result.baseline.networkHash);
      expect(result.proposal.demandHash).toBe(result.baseline.demandHash);
      expect(result.proposal.trips[0].durationSeconds).toBeGreaterThan(
        result.baseline.trips[0].durationSeconds!,
      );
      expect(sha(network.networkXml)).toBe(before);
    }, 30000);
    it("repairs an internal closure through the actual alternate path with unchanged OD", async () => {
      const input = await request();
      input.overlays = [{ edgeId: input.vehicles[0].edges[1], closed: true }];
      const survivingMovement = network.network.connections.find(
        (c) => c.fromEdge === "20" && c.toEdge === "21",
      )!;
      input.counts.push({
        ...input.counts[0],
        id: "turn-survives-closure",
        target: { kind: "turn", connectionId: survivingMovement.id },
        value: 0,
      });
      const result = await runtime.runPair(input).catch(async (error) => {
        throw new Error(
          error.message +
            "\n" +
            (await readFile(join(root, "work", "last-error.json"), "utf8")),
        );
      });
      expect(result.proposal.diagnostics.arrived).toBe(20);
      expect(result.proposal.assignedRoutesHash).not.toBe(
        result.baseline.assignedRoutesHash,
      );
      expect(result.proposal.trips[0].routeLengthMeters).toBeGreaterThan(
        result.baseline.trips[0].routeLengthMeters!,
      );
      expect(
        result.proposalNetwork.connections.find(
          (c) => c.id === survivingMovement.id,
        ),
      ).toMatchObject({
        fromEdge: "20",
        toEdge: "21",
        fromLane: "20_0",
        toLane: "21_0",
      });
      expect(
        result.baseline.predictions.find(
          (c) => c.countId === "turn-survives-closure",
        ),
      ).toMatchObject({ vehicles: 0, status: "available" });
      expect(
        result.proposal.predictions.find(
          (c) => c.countId === "turn-survives-closure",
        ),
      ).toMatchObject({ vehicles: 20, status: "available" });
    }, 30000);
    it("executes a reviewed lane target and exact mph conversion in the native graph", async () => {
      const input = await request();
      const edgeId = input.vehicles[0].edges[1];
      input.overlays = [{ edgeId, lanes: 2, speedMps: 25 * 0.44704 }];
      const result = await runtime.runPair(input);
      const edge = result.proposalNetwork.edges.find(
        (value) => value.id === edgeId,
      )!;
      expect(edge.lanes).toHaveLength(2);
      expect(
        edge.lanes.every((lane) => Math.abs(lane.speedMps - 11.176) < 0.000001),
      ).toBe(true);
      expect(result.proposal.diagnostics.arrived).toBe(20);
      expect(result.baseline.demandHash).toBe(result.proposal.demandHash);
      expect(result.proposalNetwork.manifest.conversion.options).toContain(
        "--precision",
      );
    }, 30000);
    it("rejects graph hash tampering, unsupported geometry edits and malformed routes before native work", async () => {
      const input = await request();
      await expect(
        runtime.runPair({ ...input, unsupportedChanges: ["road geometry"] }),
      ).rejects.toThrow("cannot apply");
      await expect(
        runtime.runPair({
          ...input,
          network: { ...network, networkXml: Buffer.from("wrong") },
        }),
      ).rejects.toThrow("do not match");
      input.vehicles[0].edges.reverse();
      await expect(runtime.runPair(input)).rejects.toThrow("prohibited");
    });
    it("retains unfinished and uninserted vehicles without reporting them as completed trips", async () => {
      const input = await request();
      input.period.endSeconds = 10;
      input.period.cooldownSeconds = 0;
      input.counts = [];
      input.vehicles = Array.from({ length: 200 }, (_, i) => ({
        ...input.vehicles[0],
        id: `queue-${i}`,
        departSeconds: 0,
      }));
      const result = await runtime.runPair(input);
      expect(result.baseline.diagnostics.arrived).toBe(0);
      expect(result.baseline.diagnostics.waiting).toBeGreaterThan(0);
      expect(result.baseline.trips).toHaveLength(200);
      expect(
        result.baseline.trips.every(
          (t) => t.requestedDepartSeconds === 0 && !t.arrived,
        ),
      ).toBe(true);
      expect(result.baseline.trips.some((t) => t.departSeconds === null)).toBe(
        true,
      );
    }, 30000);
    it("rejects a false graph inventory even when the native XML hash is unchanged", async () => {
      const input = await request();
      input.network = { ...network, network: structuredClone(network.network) };
      input.network.network.edges[0].lanes[0].speedMps += 1;
      await expect(runtime.runPair(input)).rejects.toThrow("inventory differs");
    }, 30000);
    it("keeps a grade-separated crossing disconnected when source nodes do not join", async () => {
      const crossing = `<osm version="0.6"><node id="101" lat="33" lon="-112.002"/><node id="102" lat="33" lon="-111.998"/><node id="201" lat="32.998" lon="-112"/><node id="202" lat="33.002" lon="-112"/><way id="101"><nd ref="101"/><nd ref="102"/><tag k="highway" v="primary"/><tag k="bridge" v="yes"/><tag k="layer" v="1"/></way><way id="201"><nd ref="201"/><nd ref="202"/><tag k="highway" v="primary"/></way></osm>`;
      await writeFile(join(root, "crossing.osm.xml"), crossing);
      const graph = await runtime.prepareNetwork({
        osmXmlPath: join(root, "crossing.osm.xml"),
        osmXmlSha256: sha(crossing),
        bounds: [-112.003, 32.997, -111.997, 33.003],
        sources: [source],
        sourceFiles: [
          {
            sourceId: source.id,
            url: source.url,
            sha256: sha(crossing),
            bytes: Buffer.byteLength(crossing),
            retrievedAt: "2026-11-06T00:00:00Z",
          },
        ],
      });
      expect(graph.network.nodes).toHaveLength(4);
      expect(graph.network.connections).toHaveLength(0);
      expect(graph.networkXml.toString()).toContain("bridge");
    }, 30000);
    it("terminates the whole sandbox on cancellation and leaves no job scratch directory", async () => {
      const input = await request(),
        controller = new AbortController();
      input.signal = controller.signal;
      const pending = runtime.runPair(input);
      setTimeout(() => controller.abort(), 120);
      await expect(pending).rejects.toThrow();
      const { readdir } = await import("node:fs/promises");
      expect(
        (await readdir(join(root, "work"))).filter((n) => n.startsWith("job-")),
      ).toEqual([]);
    });
  },
);

describe("native traffic availability is explicit", () => {
  it("pins a digest and refuses to substitute an unverified image", () => {
    expect(SUMO_IMAGE).toMatch(
      /^ghcr\.io\/eclipse-sumo\/sumo@sha256:[a-f0-9]{64}$/,
    );
  });
});
