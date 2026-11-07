import { ArrowRight } from "lucide-react";
import "./traffic.css";
export function TrafficPanel({
  onOpen,
  networkAvailable,
}: {
  onOpen: () => void;
  networkAvailable?: boolean;
}) {
  return (
    <section className="traffic-entry">
      <span className="eyebrow">STREETS WITH EVIDENCE</span>
      <h3>Understand the next turn.</h3>
      <p>
        Review counts, directed connections and real paired traffic runs across
        the study area and its external network.
      </p>
      <span className="traffic-badge">
        {networkAvailable
          ? "Traffic network available"
          : networkAvailable === false
            ? "Source preparation required"
            : "Check network availability"}
      </span>
      <button type="button" className="button full-width" onClick={onOpen}>
        Open traffic workbench <ArrowRight size={15} />
      </button>
      <small>
        Saved simulations play their SUMO vehicles on the map.
      </small>
    </section>
  );
}
