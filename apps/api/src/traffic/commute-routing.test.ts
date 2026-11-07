import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import {
  projectCommuteNativeGeometry,
  restoreCommuteNativeGeometry,
  commuteProjectionArtifact,
} from "./commute-routing-projection.js";
import { trafficNetworkFixture } from "../../../../packages/core/src/traffic-fixture.js";
import { canonicalJSON, type TrafficNetwork, type Position } from "@urban/core";
import {
  buildCommuteNativeIndex,
  matchCommuteRoute,
  projectRetainedCommuteAttachment,
} from "./commute-routing.js";
import {
  CommuteValhallaRouter,
  commuteBytesHash,
  commuteHash,
  normalizeCommuteRoute,
  type CommuteRegionalRoute,
  decodeCommutePolyline,
} from "./commute-routing-valhalla.js";
const hash = "a".repeat(64),
  settings = "b".repeat(64);
function native() {
  const n = trafficNetworkFixture(),
    shape: Position[] = [
      [-112.003, 33],
      [-112.002, 33],
      [-112.001, 33],
    ];
  n.manifest.bounds = [-112.0031, 32.999, -112.0009, 33.001];
  n.manifest.sourceFiles = [
    {
      sourceId: "fixture",
      url: "https://example.test/fixture.osm.pbf",
      sha256: hash,
      bytes: 1,
      retrievedAt: "2026-01-01T00:00:00Z",
    },
  ];
  n.nodes = shape.map((position, i) => ({
    id: String(i),
    position,
    type: "priority",
    external: i !== 1,
    quality: "authored",
    sourceIds: ["fixture"],
  }));
  n.edges = shape.slice(1).map((_, i) => ({
    id: "e" + i,
    from: String(i),
    to: String(i + 1),
    sourceWayIds: [String(i + 1)],
    quality: "authored",
    sourceIds: ["fixture"],
    lanes: [
      {
        id: "e" + i + "_0",
        index: 0,
        shape: [shape[i], shape[i + 1]],
        lengthMeters: 100,
        speedMps: 10,
        allowedClasses: ["passenger"],
        quality: "authored",
        sourceIds: ["fixture"],
      },
    ],
  }));
  n.connections = [
    {
      id: "c",
      fromEdge: "e0",
      toEdge: "e1",
      fromLane: "e0_0",
      toLane: "e1_0",
      viaLaneIds: [],
      direction: "straight",
      quality: "authored",
      sourceIds: ["fixture"],
    },
  ];
  n.signals = [];
  return {
    network: n,
    xml: () => {
      const xml = Buffer.from(
        "<net>" +
          n.edges
            .map(
              (e, i) =>
                `<edge id="${e.id}" from="${e.from}" to="${e.to}"><lane id="${e.lanes[0].id}" index="0" length="100" allow="${e.lanes[0].allowedClasses.join(" ")}"><param key="origId" value="${i + 1}"/></lane></edge>`,
            )
            .join("") +
          n.connections
            .map(
              (c) =>
                `<connection from="${c.fromEdge}" to="${c.toEdge}" fromLane="0" toLane="0"/>`,
            )
            .join("") +
          "</net>",
      );
      n.manifest.networkFileSha256 = commuteBytesHash(xml);
      return xml;
    },
  };
}
function regional(
  shape: Position[] = [
    [-112.0028, 33],
    [-112.002, 33],
    [-112.0012, 33],
  ],
): CommuteRegionalRoute {
  return {
    version: 1,
    request: { home: shape[0], work: shape.at(-1)! },
    graphHash: hash,
    settingsHash: settings,
    sourcePbfHash: hash,
    shape,
    segmentSeconds: [8, 8],
    edges: [
      {
        id: "v1",
        wayId: "1",
        forward: true,
        beginShapeIndex: 0,
        endShapeIndex: 1,
        startSeconds: 0,
        endSeconds: 8,
        sourcePercentAlong: 0.2,
        targetPercentAlong: 1,
      },
      {
        id: "v2",
        wayId: "2",
        forward: true,
        beginShapeIndex: 1,
        endShapeIndex: 2,
        startSeconds: 8,
        endSeconds: 16,
        sourcePercentAlong: 0,
        targetPercentAlong: 0.8,
      },
    ],
    seconds: 16,
    homeSnapMeters: 0,
    workSnapMeters: 0,
    rawRouteHash: hash,
    rawTraceHash: hash,
    notes: [],
  };
}
describe("source-bound regional/local route correspondence", () => {
  it("retains exact partial endpoint lanes and source geometry without changing native inventory", () => {
    const { network, xml } = native(),
      index = buildCommuteNativeIndex(network, xml()),
      before = JSON.stringify(network),
      r = matchCommuteRoute("f", regional(), index);
    expect(r.attachment.status).toBe("routed");
    expect(r.attachment.local).toMatchObject({
      edges: ["e0", "e1"],
      classification: "internal",
      prefixSeconds: 0,
      suffixSeconds: 0,
      departLaneId: "e0_0",
      arrivalLaneId: "e1_0",
    });
    expect(r.attachment.local!.departPositionMeters).toBeCloseTo(20, 4);
    expect(r.attachment.local!.arrivalPositionMeters).toBeCloseTo(80, 4);
    expect(JSON.stringify(network)).toBe(before);
    expect(r.evidence.bindingHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("retains regional prefix and suffix time for a through route with explicit partial-edge interpolation", () => {
    const { network, xml } = native();
    const route = regional([
      [-112.004, 33],
      [-112.002, 33],
      [-112, 33],
    ]);
    const result = matchCommuteRoute(
      "f",
      route,
      buildCommuteNativeIndex(network, xml()),
    );
    expect(result.attachment.status).toBe("routed");
    expect(result.attachment.local!.classification).toBe("through");
    expect(result.attachment.local!.prefixSeconds).toBeCloseTo(4, 4);
    expect(result.attachment.local!.suffixSeconds).toBeCloseTo(4, 4);
    expect(result.attachment.local!.departPositionMeters).toBe(0);
    expect(result.attachment.local!.arrivalPositionMeters).toBe(100);
  });
  it("retains a route that leaves and reenters the local bounding extent as unresolved, never two vehicles", () => {
    const { network, xml } = native();
    const r = regional();
    r.shape = [
      [-112.0028, 33],
      [-112.002, 33],
      [-112.002, 33.01],
      [-112.002, 33],
      [-112.0012, 33],
    ];
    r.edges = [
      { ...r.edges[0], endShapeIndex: 1 },
      {
        ...r.edges[0],
        id: "outside",
        wayId: "99",
        beginShapeIndex: 1,
        endShapeIndex: 3,
        startSeconds: 8,
        endSeconds: 100,
      },
      {
        ...r.edges[1],
        beginShapeIndex: 3,
        endShapeIndex: 4,
        startSeconds: 100,
        endSeconds: 108,
      },
    ];
    r.seconds = 108;
    r.segmentSeconds = [8, 46, 46, 8];
    const result = matchCommuteRoute(
      "f",
      r,
      buildCommuteNativeIndex(network, xml()),
    );
    expect(result.attachment.status).toBe("reentry-unsupported");
    expect(result.attachment.local).toBeNull();
  });
  it.each([
    ["99", 2],
    ["99", 3],
    ["1", 2],
    ["1", 3],
  ] as const)(
    "rejects an unrepresented44m regional detour even belowthe old75m gap bound (way%s, policy%s)",
    (way, policyVersion) => {
      const { network, xml } = native(),
        r = regional();
      r.shape = [
        [-112.0028, 33],
        [-112.002, 33],
        [-112.002, 33.0002],
        [-112.002, 33],
        [-112.0012, 33],
      ];
      r.edges = [
        r.edges[0],
        {
          ...r.edges[0],
          id: "detour",
          wayId: way,
          beginShapeIndex: 1,
          endShapeIndex: 3,
          startSeconds: 8,
          endSeconds: 28,
        },
        {
          ...r.edges[1],
          beginShapeIndex: 3,
          endShapeIndex: 4,
          startSeconds: 28,
          endSeconds: 36,
        },
      ];
      r.segmentSeconds = [8, 10, 10, 8];
      r.seconds = 36;
      const result = matchCommuteRoute(
        "f",
        r,
        buildCommuteNativeIndex(network, xml()),
        { policyVersion },
      );
      expect(result.attachment.status).toBe("unmatched-local-network");
      expect(result.attachment.local).toBeNull();
    },
  );
  it("reconstructs exact retained local attachments and rejects changed time/cut evidence", () => {
    const { network, xml } = native(),
      route = regional(),
      result = matchCommuteRoute(
        "f",
        route,
        buildCommuteNativeIndex(network, xml()),
      );
    expect(
      projectRetainedCommuteAttachment("f", route, { ...result.evidence }),
    ).toEqual(result.attachment.local);
    const changed = structuredClone(result.evidence);
    changed.selected[0].laneStart += 1;
    expect(() =>
      projectRetainedCommuteAttachment("f", route, { ...changed }),
    ).toThrow(/bound regional proof/);
    const time = structuredClone(route);
    time.seconds += 1;
    expect(() =>
      projectRetainedCommuteAttachment("f", time, { ...result.evidence }),
    ).toThrow(/bound regional proof/);
  });
  it("requires source identity, directed shape and connections, not nearest geometry or port flags", () => {
    const { network, xml } = native(),
      i = buildCommuteNativeIndex(network, xml());
    const r = regional();
    r.sourcePbfHash = settings;
    expect(() => matchCommuteRoute("f", r, i)).toThrow(/source PBF/);
    r.sourcePbfHash = hash;
    network.connections = [];
    const j = buildCommuteNativeIndex(network, xml());
    expect(matchCommuteRoute("f", r, j).attachment.status).toBe(
      "unmatched-local-network",
    );
    network.edges[0].lanes[0].shape.reverse();
    expect(
      matchCommuteRoute("f", r, buildCommuteNativeIndex(network, xml()))
        .attachment.status,
    ).not.toBe("routed");
  });
  it("never strips an internal class-incompatible access leg into a pretend inbound trip", () => {
    const { network, xml } = native();
    network.edges[0].lanes[0].allowedClasses = ["bicycle"];
    const r = matchCommuteRoute(
      "f",
      regional(),
      buildCommuteNativeIndex(network, xml()),
    );
    expect(r.attachment.status).toBe("unmatched-local-network");
    expect(r.attachment.local).toBeNull();
    expect(r.attachment.notes.join(" ")).toMatch(/internal access leg/);
  });
  it("uses all exact lane original-way IDs from joined XML, not incomplete legacy edge fallback", () => {
    const { network, xml } = native();
    const raw = Buffer.from(
      xml().toString().replace('value="1"', 'value="1 91 92"'),
    );
    network.manifest.networkFileSha256 = commuteBytesHash(raw);
    const index = buildCommuteNativeIndex(network, raw);
    expect(index.ways.get("91")).toEqual(["e0"]);
    expect(network.edges[0].sourceWayIds).toEqual(["1"]);
    expect(() =>
      buildCommuteNativeIndex(network, Buffer.from("<net/>")),
    ).toThrow(/hash/);
  });
  it("respects explicit native turn and internal-via passenger restrictions", () => {
    const { network, xml } = native();
    let raw = Buffer.from(
      xml()
        .toString()
        .replace("<connection ", '<connection disallow="passenger" '),
    );
    network.manifest.networkFileSha256 = commuteBytesHash(raw);
    expect(
      matchCommuteRoute("f", regional(), buildCommuteNativeIndex(network, raw))
        .attachment.status,
    ).toBe("unmatched-local-network");
    raw = Buffer.from(
      xml()
        .toString()
        .replace(
          "<net>",
          '<net><edge id=":junction" function="internal"><lane id=":junction_0" index="0" length="5" allow="bicycle"/></edge>',
        )
        .replace("<connection ", '<connection via=":junction_0" ')
        .replace(
          "</net>",
          '<connection from=":junction" to="e1" fromLane="0" toLane="0"/></net>',
        ),
    );
    network.connections[0].viaLaneIds = [":junction_0"];
    network.manifest.networkFileSha256 = commuteBytesHash(raw);
    expect(
      matchCommuteRoute("f", regional(), buildCommuteNativeIndex(network, raw))
        .attachment.status,
    ).toBe("unmatched-local-network");
  });
  it("rejects DTDs, duplicate identities and native length drift", () => {
    const { network, xml } = native();
    const raw = Buffer.from(
      '<!DOCTYPE net [<!ENTITY x SYSTEM "file:///secret">]>' + xml().toString(),
    );
    network.manifest.networkFileSha256 = commuteBytesHash(raw);
    expect(() => buildCommuteNativeIndex(network, raw)).toThrow(
      /document types/,
    );
    const good = xml();
    network.edges[0].lanes[0].lengthMeters = 99;
    expect(() => buildCommuteNativeIndex(network, good)).toThrow(/length/);
  });
});
function encode(points: Position[]) {
  let a = 0,
    b = 0,
    out = "";
  const part = (n: number) => {
    let v = n < 0 ? -n * 2 - 1 : n * 2;
    while (v >= 32) {
      out += String.fromCharCode((v % 32 | 32) + 63);
      v = Math.floor(v / 32);
    }
    out += String.fromCharCode(v + 63);
  };
  for (const [lon, lat] of points) {
    const x = Math.round(lat * 1e6),
      y = Math.round(lon * 1e6);
    part(x - a);
    part(y - b);
    a = x;
    b = y;
  }
  return out;
}
function raw() {
  const shape: Position[] = [
      [-112.003, 33],
      [-112.002, 33],
      [-112.001, 33],
    ],
    encoded = encode(shape);
  return {
    shape,
    route: Buffer.from(
      JSON.stringify({
        trip: {
          status: 0,
          summary: { time: 20, length: 0.2 },
          legs: [{ shape: encoded }],
        },
      }),
    ),
    trace: Buffer.from(
      JSON.stringify({
        shape: encoded,
        edges: [
          {
            id: 1,
            way_id: 1,
            forward: true,
            begin_shape_index: 0,
            end_shape_index: 1,
            end_node: { elapsed_time: 10 },
          },
          {
            id: 2,
            way_id: 2,
            forward: true,
            begin_shape_index: 1,
            end_shape_index: 2,
            end_node: { elapsed_time: 20 },
          },
        ],
        shape_attributes: { time: [9, 9] },
        alternate_paths: [],
      }),
    ),
  };
}
describe("bounded exact route/trace evidence", () => {
  it("retains differing cumulative elapsed and shape travel times rather than deleting junction delay", () => {
    const r = raw(),
      v = normalizeCommuteRoute({
        home: r.shape[0],
        work: r.shape[2],
        graphHash: hash,
        settingsHash: settings,
        sourcePbfHash: hash,
        rawRoute: r.route,
        rawTrace: r.trace,
      });
    expect(v.route.seconds).toBe(20);
    expect(v.route.segmentSeconds).toEqual([9, 9]);
    expect(v.route.edges[1].startSeconds).toBe(10);
    expect(v.route.edges[0].sourcePercentAlong).toBeNull();
    expect(decodeCommutePolyline(encode(r.shape))).toEqual(r.shape);
  });
  it("rejects alternate trace shape, missing per-segment time and disconnected trace edges", () => {
    const r = raw(),
      t = JSON.parse(r.trace.toString());
    t.edges[1].begin_shape_index = 0;
    expect(() =>
      normalizeCommuteRoute({
        home: r.shape[0],
        work: r.shape[2],
        graphHash: hash,
        settingsHash: settings,
        sourcePbfHash: hash,
        rawRoute: r.route,
        rawTrace: Buffer.from(JSON.stringify(t)),
      }),
    ).toThrow(/disconnected/);
    expect(() => decodeCommutePolyline("~~~~~")).toThrow();
  });
  it("refuses external endpoints and oversized streamed responses without retaining them", async () => {
    expect(
      () =>
        new CommuteValhallaRouter("https://example.test/", {
          graphHash: hash,
          settingsHash: settings,
          sourcePbfHash: hash,
        }),
    ).toThrow(/loopback/);
    let retained = 0,
      cancelled = false;
    const router = new CommuteValhallaRouter(
      "http://127.0.0.1:8004",
      { graphHash: hash, settingsHash: settings, sourcePbfHash: hash },
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(17 * 1024 ** 2));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      async () => {
        retained++;
      },
    );
    await expect(router.route([-112, 33], [-112.01, 33])).rejects.toThrow(
      /byte bound/,
    );
    expect(retained).toBe(0);
    expect(cancelled).toBe(true);
  });
  it("calls only route then exact edge_walk and retains both bounded raw bodies", async () => {
    const r = raw(),
      bodies: Record<string, unknown>[] = [],
      retained: string[] = [];
    const router = new CommuteValhallaRouter(
      "http://127.0.0.1:8004",
      { graphHash: hash, settingsHash: settings, sourcePbfHash: hash },
      async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(bodies.length === 1 ? r.route : r.trace);
      },
      async (action) => {
        retained.push(action);
      },
    );
    await router.route(r.shape[0], r.shape[2]);
    expect(bodies[1].shape_match).toBe("edge_walk");
    expect(retained).toEqual(["route", "trace_attributes"]);
  });
});

describe("offline native internal geometry projection", () => {
  it.skipIf(!existsSync("/usr/bin/cs2cs"))(
    "applies captured offsets/WGS84 UTM and binds binary+input+output without mutatinginventory",
    async () => {
      const { network, xml } = native(),
        index = buildCommuteNativeIndex(network, xml());
      index.xmlProjection = {
        parameters:
          "+proj=utm +zone=12 +ellps=WGS84 +datum=WGS84 +units=m +no_defs",
        netOffset: [-499000, 2000],
      };
      index.rawInternalShapes.set(":via", [
        [1000, 2000],
        [1100, 2000],
      ]);
      const before = JSON.stringify(network),
        projected = await projectCommuteNativeGeometry(index),
        points = projected.internalShapes.get(":via")!;
      expect(points[0][0]).toBeCloseTo(-111, 10);
      expect(points[0][1]).toBeCloseTo(0, 10);
      expect(points[1][0]).toBeGreaterThan(-111);
      expect(projected.projectionHash).toMatch(/^[a-f0-9]{64}$/);
      expect(commuteHash(projected.projectionReceipt)).toBe(
        projected.projectionHash,
      );
      const artifact = commuteProjectionArtifact(projected),
        bytes = Buffer.from(canonicalJSON(artifact)),
        restored = restoreCommuteNativeGeometry(index, bytes);
      expect([...restored.internalShapes]).toEqual([
        ...projected.internalShapes,
      ]);
      const tampered = {
        ...artifact,
        output: artifact.output.replace(
          "-111.000000000000",
          "-110.000000000000",
        ),
      };
      expect(() =>
        restoreCommuteNativeGeometry(
          index,
          Buffer.from(canonicalJSON(tampered)),
        ),
      ).toThrow(/exact XML/);
      index.rawInternalShapes.get(":via")![0][0] += 1;
      expect(() => restoreCommuteNativeGeometry(index, bytes)).toThrow(
        /exact XML/,
      );
      expect(index.internalShapes.size).toBe(0);
      expect(JSON.stringify(network)).toBe(before);
    },
  );
  it("rejects unapprovedprojection parameters beforelaunching an externaltool", async () => {
    const { network, xml } = native(),
      index = buildCommuteNativeIndex(network, xml());
    index.xmlProjection = {
      parameters: "+init=https://example.test/projection",
      netOffset: [0, 0],
    };
    await expect(projectCommuteNativeGeometry(index)).rejects.toThrow(
      /explicit offline/,
    );
  });
});
