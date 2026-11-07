import { LayerExtension, type Layer } from "@deck.gl/core";

export const clampRevealPercent = (value = 50): number =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 50;

export interface RevealLayerProps {
  /** -1 = before/left, 1 = after/right, 0 = shared/unclipped. */
  revealSide: number;
  revealPercent: number;
}

const revealUniforms = {
  name: "urbanReveal",
  fs: `layout(std140) uniform urbanRevealUniforms {
    float divider;
    float side;
  } urbanReveal;`,
  uniformTypes: { divider: "f32", side: "f32" },
} as const;

/** Shared camera, complementary fragment masks; discarded pixels never write depth.
 * Uses the supported deck shader hook + module uniforms, including composite sublayers.
 * https://deck.gl/docs/developer-guide/custom-layers/layer-extensions
 */
export class RevealExtension extends LayerExtension {
  static extensionName = "UrbanReveal";
  static defaultProps = { revealSide: 0, revealPercent: 50 };

  getShaders() {
    return {
      modules: [revealUniforms],
      inject: {
        "fs:DECKGL_FILTER_COLOR": `
          if ((urbanReveal.side < 0.0 && gl_FragCoord.x >= urbanReveal.divider) ||
              (urbanReveal.side > 0.0 && gl_FragCoord.x < urbanReveal.divider)) discard;
        `,
      },
    };
  }

  draw(this: Layer<RevealLayerProps>) {
    // Read the real drawing buffer so HiDPI and resized maps use the same screen split.
    const width =
      this.context.device.canvasContext?.getDrawingBufferSize()[0] ?? 0;
    for (const model of this.getModels())
      model.shaderInputs.setProps({
        urbanReveal: {
          divider: (width * clampRevealPercent(this.props.revealPercent)) / 100,
          side: this.props.revealSide,
        },
      });
  }
}

const extension = new RevealExtension();
/** Cloning keeps materialized arrays and GPU attributes stable when only the divider moves. */
export function clipRevealLayers(layers: Layer[], percent: number): Layer[] {
  return layers.map((layer) => {
    if (layer.id === "reference-area") return layer;
    const clipProps = {
      extensions: [extension],
      revealSide: layer.id.startsWith("before-") ? -1 : 1,
      revealPercent: clampRevealPercent(percent),
      pickable: false,
      autoHighlight: false,
    };
    return layer.clone(clipProps);
  });
}
