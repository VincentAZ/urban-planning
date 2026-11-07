import { createHash } from "node:crypto";
import { SaxesParser } from "saxes";
import { ApiError } from "../errors.js";

export const TRAFFIC_SERVICE_ACCESS_POLICY =
  "infer-unrestricted-service-passenger" as const;
export type TrafficServiceAccessPolicy = typeof TRAFFIC_SERVICE_ACCESS_POLICY;
export const TRAFFIC_SERVICE_ACCESS_LIMITS = Object.freeze({
  sourceBytes: 100 * 1024 * 1024,
  nodes: 1_000_000,
  ways: 200_000,
  references: 2_000_000,
  elements: 4_000_000,
  ledgerBytes: 1024 * 1024,
});
export interface TrafficServiceAccessReason {
  code:
    | "access-restricted"
    | "access-variant-unsupported"
    | "node-barrier"
    | "service-purpose-restricted"
    | "service-transit-unsupported";
  key: string;
  value: string;
  nodeId?: string;
  message: string;
}
export interface TrafficServiceAccessLedger {
  version: 1;
  policy: TrafficServiceAccessPolicy;
  sourceSha256: string;
  eligibleServiceWayIds: string[];
  passengerRestrictedWays: {
    wayId: string;
    reasons: TrafficServiceAccessReason[];
  }[];
  inventory: {
    nodes: number;
    ways: number;
    highwayWays: number;
    serviceWays: number;
  };
  notes: string[];
}
interface Entity {
  id: string;
  tags: Map<string, string>;
  references: string[];
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function fail(message: string): never {
  throw new ApiError(422, "TRAFFIC_SERVICE_ACCESS_INVALID", message);
}
function bounded(message: string): never {
  throw new ApiError(413, "TRAFFIC_SERVICE_ACCESS_LIMIT", message);
}
const acceptedAccess = new Set(["yes", "permissive", "designated"]);
const ordinaryService = new Set(["", "alley", "driveway", "parking_aisle"]);

/** Deliberately conservative: conditional rights and narrower overrides are never inferred. */
function restrictions(
  tags: ReadonlyMap<string, string>,
  nodeId?: string,
): TrafficServiceAccessReason[] {
  const result: TrafficServiceAccessReason[] = [];
  for (const [key, raw] of [...tags].sort(([a], [b]) => compare(a, b))) {
    const normalized = key.toLowerCase(),
      value = raw.trim().toLowerCase();
    const conditional = /(?:^|:)conditional(?::|$)/.test(normalized);
    if (
      conditional ||
      /^(?:access|vehicle|motor_vehicle|motorcar)(?::|$)/.test(normalized)
    ) {
      const variant = conditional || normalized.includes(":");
      if (variant || !acceptedAccess.has(value))
        result.push({
          code: variant ? "access-variant-unsupported" : "access-restricted",
          key,
          value: raw,
          ...(nodeId ? { nodeId } : {}),
          message: variant
            ? "Conditional, directional or lane-specific access is not resolved by this static passenger policy."
            : "The source does not grant unrestricted passenger use; conflicting broader and narrower tags are conservatively withheld.",
        });
    }
    if (
      nodeId &&
      normalized === "barrier" &&
      !["no", "entrance"].includes(value)
    )
      result.push({
        code: "node-barrier",
        key,
        value: raw,
        nodeId,
        message:
          "An incident source node has a barrier whose passenger passage is not established by this policy.",
      });
  }
  return result;
}

/**
 * Inspect immutable OSM bytes only. This is a versioned modeling policy, not a
 * legal-access certification. Callers must retain this ledger and verify final
 * native lane permissions against complete original-way lineage.
 */
export function inspectTrafficServiceAccess(
  bytes: Buffer,
  policy: TrafficServiceAccessPolicy,
): TrafficServiceAccessLedger {
  if (policy !== TRAFFIC_SERVICE_ACCESS_POLICY)
    fail("Unknown native passenger service-access policy.");
  if (!Buffer.isBuffer(bytes) || !bytes.length)
    fail("Original OSM XML is required for service-access review.");
  if (bytes.length > TRAFFIC_SERVICE_ACCESS_LIMITS.sourceBytes)
    bounded("OSM service-access input exceeds 100 MiB.");
  const parser = new SaxesParser({ xmlns: false });
  const path: string[] = [],
    nodeIds = new Set<string>(),
    wayIds = new Set<string>();
  const nodeRestrictions = new Map<string, TrafficServiceAccessReason[]>(),
    ways: Entity[] = [];
  let active: Entity | undefined,
    elements = 0,
    references = 0,
    rootSeen = false;
  const sourceId = (value: string | undefined) => {
    if (!value || !/^[1-9]\d{0,19}$/.test(value))
      fail("OSM entities require positive bounded source IDs.");
    return value;
  };
  parser.on("doctype", () =>
    fail("OSM document types and external entities are not supported."),
  );
  parser.on("error", () => fail("Original OSM XML is malformed."));
  parser.on("opentag", (tag) => {
    if (++elements > TRAFFIC_SERVICE_ACCESS_LIMITS.elements || path.length >= 8)
      bounded("OSM service-access structural bounds exceeded.");
    const a = tag.attributes as Record<string, string>,
      name = tag.name;
    if (
      Object.keys(a).length > 64 ||
      Object.entries(a).some(
        ([key, value]) => key.length > 256 || value.length > 4096,
      )
    )
      bounded("OSM element attributes exceed bounded key/value limits.");
    if (!path.length) {
      if (rootSeen || name !== "osm")
        fail(
          "A single OSM document is required; change documents are unsupported.",
        );
      rootSeen = true;
    } else if (path.length === 1) {
      if (
        ![
          "node",
          "way",
          "relation",
          "bounds",
          "bound",
          "note",
          "meta",
        ].includes(name)
      )
        fail("Unsupported top-level OSM element.");
      if (name === "node" || name === "way") {
        const id = sourceId(a.id),
          ids = name === "node" ? nodeIds : wayIds;
        if (ids.has(id))
          fail(
            "Duplicate OSM entity ID; no conflicting access declarations are discarded.",
          );
        ids.add(id);
        if (
          ids.size >
          TRAFFIC_SERVICE_ACCESS_LIMITS[name === "node" ? "nodes" : "ways"]
        )
          bounded("OSM node or way inventory exceeds the access-review bound.");
        active = { id, tags: new Map(), references: [] };
      } else active = undefined;
    } else if (path.length === 2 && (path[1] === "node" || path[1] === "way")) {
      if (!active) fail("Malformed OSM entity hierarchy.");
      if (name === "tag") {
        if (
          typeof a.k !== "string" ||
          typeof a.v !== "string" ||
          !a.k.length ||
          a.k.length > 256 ||
          a.v.length > 4096
        )
          bounded("OSM tag exceeds bounded key/value limits.");
        if (active.tags.has(a.k))
          fail("Duplicate OSM tag key; access precedence is ambiguous.");
        if (active.tags.size >= 256) bounded("OSM entity has too many tags.");
        active.tags.set(a.k, a.v);
      } else if (name === "nd" && path[1] === "way") {
        if (
          ++references > TRAFFIC_SERVICE_ACCESS_LIMITS.references ||
          active.references.length >= 10000
        )
          bounded("OSM way-reference bounds exceeded.");
        active.references.push(sourceId(a.ref));
      } else fail("Unsupported nested OSM node/way element.");
    } else if (path.length > 2 && (path[1] === "node" || path[1] === "way"))
      fail("Nested OSM tags or references are unsupported.");
    path.push(name);
  });
  parser.on("closetag", () => {
    if (path.length === 2 && active) {
      if (path[1] === "node") {
        const reasons = restrictions(active.tags, active.id);
        if (reasons.length) nodeRestrictions.set(active.id, reasons);
      } else if (path[1] === "way") {
        if (active.references.length < 2)
          fail("OSM way has fewer than two source nodes.");
        ways.push(active);
      }
      active = undefined;
    }
    path.pop();
  });
  parser.on("text", (value) => {
    if (value.trim() && path[1] !== "note")
      fail("Unexpected text in OSM entity data.");
  });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (let offset = 0; offset < bytes.length; offset += 65536)
      parser.write(
        decoder.decode(bytes.subarray(offset, offset + 65536), {
          stream: true,
        }),
      );
    parser.write(decoder.decode()).close();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail("Original OSM input is not valid bounded UTF-8/XML.");
  }
  if (!rootSeen || !nodeIds.size || !ways.length)
    fail("OSM input has no source nodes or ways.");
  const eligibleServiceWayIds: string[] = [],
    passengerRestrictedWays: TrafficServiceAccessLedger["passengerRestrictedWays"] =
      [];
  let highwayWays = 0,
    serviceWays = 0,
    decisionBytes = 0;
  const reserve = (value: unknown) => {
    decisionBytes += Buffer.byteLength(JSON.stringify(value)) + 1;
    if (decisionBytes > TRAFFIC_SERVICE_ACCESS_LIMITS.ledgerBytes)
      bounded(
        "Complete service-access ledger exceeds 1 MiB; no decisions were truncated.",
      );
  };
  for (const way of ways.sort((a, b) => compare(a.id, b.id))) {
    if (way.references.some((id) => !nodeIds.has(id)))
      fail(
        "OSM way references missing source nodes; no access completeness claim is possible.",
      );
    if (!way.tags.has("highway")) continue;
    highwayWays++;
    const service = way.tags.get("highway") === "service";
    if (service) serviceWays++;
    const reasons: TrafficServiceAccessReason[] = [];
    const append = (reason: TrafficServiceAccessReason) => {
      reserve(reason);
      reasons.push(reason);
    };
    for (const reason of restrictions(way.tags)) append(reason);
    for (const node of [...new Set(way.references)].sort(compare))
      for (const reason of nodeRestrictions.get(node) ?? []) append(reason);
    if (service) {
      const subtype = way.tags.get("service")?.trim().toLowerCase() ?? "";
      if (!ordinaryService.has(subtype))
        append({
          code: "service-purpose-restricted",
          key: "service",
          value: way.tags.get("service")!,
          message:
            "Special-purpose or unknown service-road use is not assumed to admit general passenger traffic.",
        });
      for (const [key, value] of [...way.tags].sort(([a], [b]) =>
        compare(a, b),
      )) {
        if (
          /^(?:bus|psv)(?::|$)/i.test(key) &&
          !/(?:^|:)conditional(?::|$)/i.test(key) &&
          (key.includes(":") || value.trim().toLowerCase() !== "no")
        )
          append({
            code: "service-transit-unsupported",
            key,
            value,
            message:
              "A transit-tagged service way requires a separate reviewed passenger-access decision.",
          });
      }
    }
    if (reasons.length) {
      reserve({ wayId: way.id, reasons: [] });
      passengerRestrictedWays.push({ wayId: way.id, reasons });
    } else if (service) {
      reserve(way.id);
      eligibleServiceWayIds.push(way.id);
    }
  }
  const ledger: TrafficServiceAccessLedger = {
    version: 1,
    policy,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    eligibleServiceWayIds,
    passengerRestrictedWays,
    inventory: {
      nodes: nodeIds.size,
      ways: wayIds.size,
      highwayWays,
      serviceWays,
    },
    notes: [
      "Passenger eligibility on otherwise unrestricted source highway=service ways is an explicit operator modeling assumption, not observed access or a legal determination.",
      "Any restrictive or unresolved access-family tag wins conservatively; this policy does not infer narrower exceptions, conditional calendars, destination privileges or permission to pass a barrier.",
      "Only passenger permissions may change. Other native classes, topology, one-way direction, speed and original source bytes must remain unchanged.",
      "A native lane may gain passenger access only when its complete original-way lineage is known and every contributing way is eligible. Mixed or missing lineage must fail rather than expand permissions.",
      "Any restricted contributing way prohibits passenger expansion and requires passenger removal; incident node restrictions conservatively affect the whole source way.",
    ],
  };
  if (
    Buffer.byteLength(JSON.stringify(ledger)) >
    TRAFFIC_SERVICE_ACCESS_LIMITS.ledgerBytes
  )
    bounded(
      "Complete service-access ledger exceeds 1 MiB; no decisions were truncated.",
    );
  return ledger;
}
