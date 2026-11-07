import { describe, it, expect } from "vitest";
import type { Position } from "@urban/core";
import { trafficNetworkFixture } from "../../../../packages/core/src/traffic-fixture.js";
import {
  buildCommuteNativeIndex,
  matchCommuteRoute,
} from "./commute-routing.js";
import {
  bindCommuteSourceGeometry,
  proveCommuteSourceJunction,
} from "./commute-routing-source.js";
import {
  commuteBytesHash,
  type CommuteRegionalRoute,
} from "./commute-routing-valhalla.js";
const p = (east: number, north: number): Position => [
  east / 111195.0802335329,
  north / 111195.0802335329,
];
function fixture(
  options: {
    nodes?: Record<string, Position>;
    way1?: string[];
    way2?: string[];
    shape?: Position[];
    firstEnd?: number;
    cluster?: boolean;
  } = {},
) {
  const nodes = {
      "1": p(0, 0),
      "2": p(40, 0),
      "3": p(0, 40),
      ...options.nodes,
    },
    junction = options.cluster ? "cluster_1_4" : "1",
    n = trafficNetworkFixture();
  n.nodes = Object.entries(nodes).map(([id, position]) => ({
    id: id === "1" ? junction : id,
    position,
    type: "priority",
    external: id !== "1",
    quality: "authored",
    sourceIds: ["fixture"],
  }));
  n.edges = [
    {
      id: "e0",
      from: "2",
      to: junction,
      sourceWayIds: ["11"],
      quality: "authored",
      sourceIds: ["fixture"],
      lanes: [
        {
          id: "e0_0",
          index: 0,
          shape: [p(40, 8), p(16, 8)],
          lengthMeters: 24,
          speedMps: 10,
          allowedClasses: ["passenger"],
          quality: "authored",
          sourceIds: ["fixture"],
        },
      ],
    },
    {
      id: "e1",
      from: junction,
      to: "3",
      sourceWayIds: ["12"],
      quality: "authored",
      sourceIds: ["fixture"],
      lanes: [
        {
          id: "e1_0",
          index: 0,
          shape: [p(8, 16), p(8, 40)],
          lengthMeters: 24,
          speedMps: 10,
          allowedClasses: ["passenger"],
          quality: "authored",
          sourceIds: ["fixture"],
        },
      ],
    },
  ];
  n.connections = [
    {
      id: "movement",
      fromEdge: "e0",
      toEdge: "e1",
      fromLane: "e0_0",
      toLane: "e1_0",
      viaLaneIds: [":J_0_0"],
      direction: "right",
      quality: "authored",
      sourceIds: ["fixture"],
    },
  ];
  n.signals = [];
  n.manifest.bounds = [-0.01, -0.01, 0.01, 0.01];
  const xml = Buffer.from(
    `<net><edge id="e0" from="2" to="${junction}"><lane id="e0_0" index="0" length="24" allow="passenger"><param key="origId" value="11"/></lane></edge><edge id="e1" from="${junction}" to="3"><lane id="e1_0" index="0" length="24" allow="passenger"><param key="origId" value="12"/></lane></edge><edge id=":J_0" function="internal"><lane id=":J_0_0" index="0" length="12" allow="passenger" shape="0,0 1,1 2,2"/></edge><connection from="e0" to="e1" fromLane="0" toLane="0" via=":J_0_0"/><connection from=":J_0" to="e1" fromLane="0" toLane="0"/></net>`,
  );
  const source = Buffer.from(
      "<osm>" +
        Object.entries(nodes)
          .map(
            ([id, pos]) => `<node id="${id}" lon="${pos[0]}" lat="${pos[1]}"/>`,
          )
          .join("") +
        `<way id="11">${(options.way1 ?? ["2", "1"]).map((id) => `<nd ref="${id}"/>`).join("")}</way><way id="12">${(options.way2 ?? ["1", "3"]).map((id) => `<nd ref="${id}"/>`).join("")}</way></osm>`,
    ),
    sourceHash = commuteBytesHash(source);
  n.manifest.networkFileSha256 = commuteBytesHash(xml);
  n.manifest.sourceFiles = [
    {
      sourceId: "fixture",
      url: "https://example.test/fixture.osm.pbf",
      sha256: "a".repeat(64),
      bytes: 1,
      retrievedAt: "2026-01-01T00:00:00Z",
    },
    {
      sourceId: "fixture",
      url: "urn:urban:traffic:osm-extract:" + sourceHash,
      sha256: sourceHash,
      bytes: source.length,
      retrievedAt: "2026-01-01T00:00:00Z",
    },
  ];
  const index = buildCommuteNativeIndex(n, xml);
  index.internalShapes.set(":J_0_0", [p(16, 8), p(10.34, 10.34), p(8, 16)]);
  const shape = options.shape ?? [p(40, 0), p(0, 0), p(0, 40)],
    firstEnd = options.firstEnd ?? 1;
  const route: CommuteRegionalRoute = {
    version: 1,
    request: { home: shape[0], work: shape.at(-1)! },
    graphHash: "a".repeat(64),
    settingsHash: "b".repeat(64),
    sourcePbfHash: "a".repeat(64),
    shape,
    segmentSeconds: shape.slice(1).map(() => 10),
    edges: [
      {
        id: "v1",
        wayId: "11",
        forward: true,
        beginShapeIndex: 0,
        endShapeIndex: firstEnd,
        startSeconds: 0,
        endSeconds: 10,
        sourcePercentAlong: null,
        targetPercentAlong: null,
      },
      {
        id: "v2",
        wayId: "12",
        forward: true,
        beginShapeIndex: firstEnd,
        endShapeIndex: shape.length - 1,
        startSeconds: 10,
        endSeconds: 20,
        sourcePercentAlong: null,
        targetPercentAlong: null,
      },
    ],
    seconds: 20,
    homeSnapMeters: 0,
    workSnapMeters: 0,
    rawRouteHash: "c".repeat(64),
    rawTraceHash: "d".repeat(64),
    notes: [],
  };
  return { index, source, route, network: n };
}
describe("exact original OSM junction alternative proof", () => {
  it("accepts a centerline right-angle turn only with continuous exact source geometry through the identical junction", () => {
    const f = fixture(),
      before = JSON.stringify(f.network);
    expect(matchCommuteRoute("f", f.route, f.index).attachment.status).toBe(
      "unmatched-local-network",
    );
    const result = matchCommuteRoute(
      "f",
      f.route,
      bindCommuteSourceGeometry(f.index, f.source),
    );
    expect(result.attachment.status).toBe("routed");
    const m = result.evidence.movements[0];
    expect(m.regionalLengthMeters).toBeGreaterThan(m.nativeLengthMeters + 5);
    expect(m.centerlineProof).toMatchObject({
      method: "exact-original-osm-junction",
      junctionNodeId: "1",
      sourceFileSha256: commuteBytesHash(f.source),
    });
    expect(m.centerlineProof!.maximumSourceResidualMeters).toBeLessThan(0.16);
    expect(result.attachment.local!.edges).toEqual(["e0", "e1"]);
    expect(JSON.stringify(f.network)).toBe(before);
  });
  it("rejects shortcutting a retained source bend even if the source way and junction IDs match", () => {
    const f = fixture({ nodes: { "4": p(15, 5) }, way1: ["2", "4", "1"] }),
      i = bindCommuteSourceGeometry(f.index, f.source);
    expect(matchCommuteRoute("f", f.route, i).attachment.status).toBe(
      "unmatched-local-network",
    );
  });
  it("rejects an uncovered interior interval even when both source runs end within junction quantization", () => {
    const f = fixture({
        shape: [p(40, 0), p(0.15, 0), p(0, 0), p(0, 0.15), p(0, 40)],
        firstEnd: 2,
      }),
      index = bindCommuteSourceGeometry(f.index, f.source),
      prove = () =>
        proveCommuteSourceJunction(
          { edgeId: "e0", end: 24 },
          { edgeId: "e1", start: 56 },
          f.network.connections[0],
          f.route,
          index,
        );
    expect(prove()).not.toBeNull();
    // The complete geometry is unchanged, but 30 cm of its regional way
    // lineage is now missing. Endpoint precision cannot fill that interval.
    f.route.edges[0].endShapeIndex = 1;
    f.route.edges[1].beginShapeIndex = 3;
    expect(prove()).toBeNull();
  });
  it.each([
    { side: "incoming", start: 40, end: 56 },
    { side: "outgoing", start: 24, end: 40 },
  ])(
    "proves the exactly zero $side side only under the explicit new policy",
    ({ side, start, end }) => {
      const f = fixture(),
        index = bindCommuteSourceGeometry(f.index, f.source),
        a = { edgeId: "e0", end: start },
        b = { edgeId: "e1", start: end };
      expect(
        proveCommuteSourceJunction(
          a,
          b,
          f.network.connections[0],
          f.route,
          index,
        ),
      ).toBeNull();
      const proof = proveCommuteSourceJunction(
        a,
        b,
        f.network.connections[0],
        f.route,
        index,
        { allowBoundarySides: true },
      );
      expect(proof?.boundarySides).toHaveLength(1);
      expect(proof?.boundarySides?.[0]).toMatchObject({
        side,
        direction: "forward",
        regionalBoundaryMeters: 40,
      });
      expect(proof?.sourceWayRuns).toHaveLength(1);
      expect(proof?.maximumSourceResidualMeters).toBeLessThan(0.16);
    },
  );
  it("does not treat a positive half-millimeter interval as an absent side", () => {
    const f = fixture(),
      index = bindCommuteSourceGeometry(f.index, f.source);
    expect(
      proveCommuteSourceJunction(
        { edgeId: "e0", end: 40 - 0.0005 },
        { edgeId: "e1", start: 56 },
        f.network.connections[0],
        f.route,
        index,
        { allowBoundarySides: true },
      ),
    ).toBeNull();
  });
  it("rejects reversed regional direction and intervening branch identities at a zero-side junction", () => {
    const f = fixture(),
      index = bindCommuteSourceGeometry(f.index, f.source),
      prove = () =>
        proveCommuteSourceJunction(
          { edgeId: "e0", end: 40 },
          { edgeId: "e1", start: 56 },
          f.network.connections[0],
          f.route,
          index,
          { allowBoundarySides: true },
        );
    expect(prove()).not.toBeNull();
    f.route.edges[0].forward = false;
    expect(prove()).toBeNull();
    f.route.edges[0].forward = true;
    f.route.edges.splice(1, 0, {
      ...f.route.edges[0],
      id: "unmatched-branch",
      wayId: "99",
      beginShapeIndex: 1,
      endShapeIndex: 1,
      startSeconds: 10,
      endSeconds: 10,
    });
    expect(prove()).toBeNull();
  });
  it("rejects a nearby source node that is not the retained native junction identity", () => {
    const f = fixture({ nodes: { "4": p(0, 0.1) }, way1: ["2", "4"] }),
      index = bindCommuteSourceGeometry(f.index, f.source);
    expect(
      proveCommuteSourceJunction(
        { edgeId: "e0", end: 40 },
        { edgeId: "e1", start: 56 },
        f.network.connections[0],
        f.route,
        index,
        { allowBoundarySides: true },
      ),
    ).toBeNull();
  });
  it("keeps source shortcuts, same-way loops and ambiguous junctions rejected under policy 3", () => {
    const cases = [
      { nodes: { "4": p(15, 5) }, way1: ["2", "4", "1"] },
      {
        shape: [p(40, 0), p(16, 0), p(16, 8), p(16, 0), p(0, 0), p(0, 40)],
        firstEnd: 4,
      },
      { shape: [p(40, 0), p(16, 0), p(20, 0), p(0, 0), p(0, 40)], firstEnd: 3 },
      { nodes: { "4": p(-5, 0) }, way1: ["2", "1", "4", "1"] },
      { cluster: true },
    ];
    for (const options of cases) {
      const f = fixture(options),
        index = bindCommuteSourceGeometry(f.index, f.source);
      expect(
        matchCommuteRoute("f", f.route, index, { policyVersion: 3 }).attachment
          .status,
      ).toBe("unmatched-local-network");
    }
  });
  it.each([
    {
      shape: [p(40, 0), p(16, 0), p(16, 8), p(16, 0), p(0, 0), p(0, 40)],
      firstEnd: 4,
    },
    { shape: [p(40, 0), p(16, 0), p(20, 0), p(0, 0), p(0, 40)], firstEnd: 3 },
  ])("rejects same-way detours, retraces and reversals", (options) => {
    const f = fixture(options);
    expect(
      matchCommuteRoute(
        "f",
        f.route,
        bindCommuteSourceGeometry(f.index, f.source),
      ).attachment.status,
    ).toBe("unmatched-local-network");
  });
  it("rejects a loop even when the source way itself retains that loop", () => {
    const shape = [p(40, 0), p(16, 0), p(16, 8), p(16, 0), p(0, 0), p(0, 40)],
      f = fixture({
        shape,
        firstEnd: 4,
        nodes: { "4": p(16, 0), "5": p(16, 8) },
        way1: ["2", "4", "5", "4", "1"],
      });
    expect(
      matchCommuteRoute(
        "f",
        f.route,
        bindCommuteSourceGeometry(f.index, f.source),
      ).attachment.status,
    ).toBe("unmatched-local-network");
  });
  it("rejects a source way with repeated junction identity and a native clustered junction", () => {
    for (const options of [
      { nodes: { "4": p(-5, 0) }, way1: ["2", "1", "4", "1"] },
      { cluster: true },
    ]) {
      const f = fixture(options);
      expect(
        matchCommuteRoute(
          "f",
          f.route,
          bindCommuteSourceGeometry(f.index, f.source),
        ).attachment.status,
      ).toBe("unmatched-local-network");
    }
  });
  it("rejects a moved native junction, detached source bytes and missing source nodes", () => {
    const f = fixture(),
      i = bindCommuteSourceGeometry(f.index, f.source);
    i.nodePositions.set("1", p(0, 2));
    expect(matchCommuteRoute("f", f.route, i).attachment.status).toBe(
      "unmatched-local-network",
    );
    expect(() =>
      bindCommuteSourceGeometry(
        f.index,
        Buffer.from(f.source.toString().replace('lon="0"', 'lon="0.1"')),
      ),
    ).toThrow(/exact retained/);
    const missing = fixture({ way1: ["2", "99", "1"] });
    expect(
      matchCommuteRoute(
        "f",
        missing.route,
        bindCommuteSourceGeometry(missing.index, missing.source),
      ).attachment.status,
    ).toBe("unmatched-local-network");
  });
  it("requires the entire gap through the node, not an unrelated shared node elsewhere on each source way", () => {
    const f = fixture(),
      i = bindCommuteSourceGeometry(f.index, f.source);
    expect(
      proveCommuteSourceJunction(
        { edgeId: "e0", end: 2 },
        { edgeId: "e1", start: 5 },
        f.network.connections[0],
        f.route,
        i,
      ),
    ).toBeNull();
  });
});
