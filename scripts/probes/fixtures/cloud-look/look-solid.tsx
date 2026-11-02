/**
 * Test fixture for the "Cloud Agent look" probe (`scripts/probes/cloud-agent-look-probe.mjs`):
 * a user card that paints the entire stage with a single color.
 *
 * The probe instructs the Cloud Agent to create it in the project content store via `create_card`,
 * place it on the timeline, and then call `see_frames`: the pixel at the center of the image is the
 * color of the `color` parameter, asserting that "what was received is how this version of the
 * project and this user card look when rendered". It probes nothing and sends no requests.
 */
import type { CardDef, CardProps } from "../../kernel/types";

type P = { color: string };

function LookSolid({ params }: CardProps<P>) {
  return <div className="absolute inset-0" style={{ background: params.color }} />;
}

export const lookSolid: CardDef<P> = {
  id: "look-solid",
  name: "Solid color card for the look probe",
  description: "Test fixture: paints the entire stage in the color given by the color parameter",
  tags: ["probe"],
  frameMode: "stateful",
  defaults: { color: "#ff0000" },
  controls: [{ key: "color", label: "Color", type: "color" }],
  Component: LookSolid,
};
