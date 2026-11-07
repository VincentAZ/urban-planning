import regular from "./fonts/DejaVuSans.ttf?url";
import bold from "./fonts/DejaVuSans-Bold.ttf?url";
let loading: Promise<void> | undefined;
export function loadMediaFonts() {
  return (loading ??= Promise.all([
    new FontFace("UrbanMedia", `url(${regular})`, { weight: "400" }).load(),
    new FontFace("UrbanMedia", `url(${bold})`, { weight: "700" }).load(),
  ])
    .then((fonts) => {
      for (const font of fonts) document.fonts.add(font);
    })
    .catch((error) => {
      loading = undefined;
      throw error;
    }));
}
