import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  inspectTrafficServiceAccess,
  TRAFFIC_SERVICE_ACCESS_POLICY,
} from "./service-access.js";

const tag = (key: string, value: string) => `<tag k="${key}" v="${value}"/>`;
const node = (id: string, tags = "") =>
  `<node id="${id}" lat="33" lon="-112">${tags}</node>`;
const way = (id: string, tags = "", highway = "service", refs = ["1", "2"]) =>
  `<way id="${id}">${refs.map((id) => `<nd ref="${id}"/>`).join("")}${tag("highway", highway)}${tags}</way>`;
const xml = (ways: string, nodes = node("1") + node("2")) =>
  Buffer.from(`<osm version="0.6">${nodes}${ways}</osm>`);
const inspect = (raw: Buffer) =>
  inspectTrafficServiceAccess(raw, TRAFFIC_SERVICE_ACCESS_POLICY);

describe("explicit source-bound service passenger policy", () => {
  it("admits ordinary unrestricted service ways and binds exact immutable bytes", () => {
    const raw = xml(
      way("10") +
        way("20", tag("service", "alley") + tag("oneway", "yes")) +
        way("30", tag("service", "driveway") + tag("access", "permissive")) +
        way(
          "40",
          tag("service", "parking_aisle") + tag("motorcar", "designated"),
        ) +
        way("50", "", "residential"),
    );
    const before = Buffer.from(raw),
      result = inspect(raw);
    expect(result).toMatchObject({
      version: 1,
      policy: TRAFFIC_SERVICE_ACCESS_POLICY,
      sourceSha256: createHash("sha256").update(raw).digest("hex"),
      eligibleServiceWayIds: ["10", "20", "30", "40"],
      passengerRestrictedWays: [],
      inventory: { nodes: 2, ways: 5, highwayWays: 5, serviceWays: 4 },
    });
    expect(raw.equals(before)).toBe(true);
  });

  it.each(["access", "vehicle", "motor_vehicle", "motorcar"])(
    "withholds restrictive %s on every highway type",
    (key) => {
      const result = inspect(
        xml(
          way("10", tag(key, "no")) +
            way("20", tag(key, "private"), "residential"),
        ),
      );
      expect(result.eligibleServiceWayIds).toEqual([]);
      expect(result.passengerRestrictedWays.map((row) => row.wayId)).toEqual([
        "10",
        "20",
      ]);
      expect(result.passengerRestrictedWays[1].reasons).toEqual([
        expect.objectContaining({
          code: "access-restricted",
          key,
          value: "private",
        }),
      ]);
    },
  );

  it.each([
    "destination",
    "customers",
    "delivery",
    "agricultural",
    "forestry",
    "permit",
    "unknown",
    "",
    "yes;no",
  ])("does not infer a passenger exception for %s", (value) => {
    expect(
      inspect(xml(way("10", tag("access", value)))).passengerRestrictedWays[0]
        .reasons[0].value,
    ).toBe(value);
  });

  it("does not treat narrow yes as overriding broad private/no", () => {
    const result = inspect(
      xml(
        way("10", tag("access", "private") + tag("motorcar", "yes")) +
          way("20", tag("vehicle", "no") + tag("motor_vehicle", "yes")),
      ),
    );
    expect(result.eligibleServiceWayIds).toEqual([]);
    expect(result.passengerRestrictedWays.map((row) => row.wayId)).toEqual([
      "10",
      "20",
    ]);
  });

  it.each([
    "access:conditional",
    "motor_vehicle:forward",
    "motorcar:lanes",
    "vehicle:backward:conditional",
    "barrier:conditional",
    "service:conditional",
    "maxspeed:conditional",
    "bus:conditional",
  ])("withholds unresolved tag %s instead of ignoring it", (key) => {
    const result = inspect(xml(way("10", tag(key, "yes"))));
    expect(result.eligibleServiceWayIds).toEqual([]);
    expect(result.passengerRestrictedWays[0].reasons).toEqual([
      expect.objectContaining({
        code: "access-variant-unsupported",
        key,
        value: "yes",
      }),
    ]);
  });

  it("propagates shared-node barriers/access to incident highway ways only, independently of XML ordering", () => {
    const ways =
      way("10") +
      way("20", "", "residential", ["2", "3"]) +
      way("30", "", "service", ["3", "4"]);
    const nodes =
      node("1") +
      node("2", tag("barrier", "gate") + tag("motorcar", "private")) +
      node("3") +
      node("4");
    const result = inspect(xml(ways, nodes));
    expect(result.eligibleServiceWayIds).toEqual(["30"]);
    expect(result.passengerRestrictedWays.map((row) => row.wayId)).toEqual([
      "10",
      "20",
    ]);
    expect(result.passengerRestrictedWays[0].reasons).toEqual([
      expect.objectContaining({
        code: "node-barrier",
        nodeId: "2",
        value: "gate",
      }),
      expect.objectContaining({
        code: "access-restricted",
        nodeId: "2",
        value: "private",
      }),
    ]);
    const reordered = inspect(Buffer.from(`<osm>${ways}${nodes}</osm>`));
    expect(reordered.passengerRestrictedWays).toEqual(
      result.passengerRestrictedWays,
    );
    expect(reordered.eligibleServiceWayIds).toEqual(
      result.eligibleServiceWayIds,
    );
  });

  it.each(["bollard", "lift_gate", "cycle_barrier", "unknown"])(
    "does not infer passage through %s",
    (barrier) => {
      expect(
        inspect(xml(way("10"), node("1", tag("barrier", barrier)) + node("2")))
          .eligibleServiceWayIds,
      ).toEqual([]);
    },
  );
  it.each(["no", "entrance"])(
    "allows an otherwise unrestricted node barrier=%s",
    (barrier) => {
      expect(
        inspect(xml(way("10"), node("1", tag("barrier", barrier)) + node("2")))
          .eligibleServiceWayIds,
      ).toEqual(["10"]);
    },
  );

  it("withholds special-purpose and transit service uses", () => {
    const result = inspect(
      xml(
        way("10", tag("service", "emergency_access")) +
          way("20", tag("service", "drive-through")) +
          way("30", tag("bus", "yes")) +
          way("40", tag("psv", "designated")) +
          way("50", tag("bus", "no")),
      ),
    );
    expect(result.eligibleServiceWayIds).toEqual(["50"]);
    expect(result.passengerRestrictedWays.map((row) => row.wayId)).toEqual([
      "10",
      "20",
      "30",
      "40",
    ]);
  });

  it.each(["bus:lanes", "psv:forward", "bus:backward"])(
    "withholds unresolved service transit variant %s",
    (key) => {
      const result = inspect(xml(way("10", tag(key, "no"))));
      expect(result.eligibleServiceWayIds).toEqual([]);
      expect(result.passengerRestrictedWays[0].reasons).toEqual([
        expect.objectContaining({ code: "service-transit-unsupported", key }),
      ]);
    },
  );

  it("rejects incomplete/conflicting source identity instead of discarding access facts", () => {
    for (const input of [
      xml(way("10"), node("1")),
      xml(way("10") + way("10")),
      xml(way("10"), node("1") + node("1") + node("2")),
      xml(way("10", tag("access", "yes") + tag("access", "no"))),
      xml(way("10", "", "service", ["1"])),
      xml(way("-10")),
    ])
      expect(() => inspect(input)).toThrow();
  });

  it("rejects document types, malformed XML/UTF-8, change files and unexpected entity content", () => {
    for (const input of [
      Buffer.from(
        '<!DOCTYPE osm [<!ENTITY x SYSTEM "file:///private">]><osm/>',
      ),
      Buffer.from('<osmChange><create><node id="1"/></create></osmChange>'),
      Buffer.from('<osm><node id="1"></osm>'),
      Buffer.concat([xml(way("10")), Buffer.from([0xff])]),
      xml(way("10"), '<node id="1">unstructured access</node>' + node("2")),
      xml(way("10", '<tag k="access" v="yes"><tag k="access" v="no"/></tag>')),
    ])
      expect(() => inspect(input)).toThrow();
  });

  it("bounds tag size and amplified restriction ledgers without truncation", () => {
    expect(() =>
      inspect(xml(way("10", tag("name", "x".repeat(4097))))),
    ).toThrow(/bounded/);
    const shared =
      node(
        "1",
        tag("access", "private") + tag("motorcar:conditional", "no @ (Mo-Fr)"),
      ) + node("2");
    const many = Array.from({ length: 3000 }, (_, i) =>
      way(String(i + 10)),
    ).join("");
    expect(() => inspect(xml(many, shared))).toThrow(/ledger exceeds 1 MiB/);
  });
});
