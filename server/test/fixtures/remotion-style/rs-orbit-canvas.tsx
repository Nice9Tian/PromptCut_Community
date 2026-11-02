/** Example card for the remotion-style framework (test fixture, not in the card library): a ring of light points circles the center on a canvas, redrawn in full every frame. */
import { useLayoutEffect, useRef } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { interpolate, loop, noise, pingPong, random, randomRange, tween } from "../../kernel/remotionStyle";

interface Params { count: number; seed: number; color: string; speed: number }

const WIDTH = 1920;
const HEIGHT = 1080;

function OrbitCanvas({ params, t = 0 }: CardProps<Params>) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    // Redraw the whole canvas from blank on every frame: no pixels from the previous frame stay on the canvas
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    const count = Math.max(1, Math.min(400, Math.round(params.count)));
    const appear = tween(t, { duration: 0.8 });
    for (let i = 0; i < count; i++) {
      const radius = randomRange(120, 460, params.seed, i, "r") * interpolate(t, [0, 1.2], [0.2, 1]);
      const turns = randomRange(0.05, 0.35, params.seed, i, "w") * params.speed;
      const angle = (random(params.seed, i, "a") + loop(t * turns, 1)) * Math.PI * 2;
      const wobble = noise(t * 2, params.seed, i) * 14;
      const x = WIDTH / 2 + Math.cos(angle) * (radius + wobble);
      const y = HEIGHT / 2 + Math.sin(angle) * (radius + wobble) * 0.6;
      const size = randomRange(3, 11, params.seed, i, "s") * (0.7 + 0.3 * pingPong(t + random(params.seed, i, "p"), 0.5) * 2);
      ctx.globalAlpha = appear * randomRange(0.35, 1, params.seed, i, "o");
      ctx.fillStyle = params.color;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, [t, params.count, params.seed, params.color, params.speed]);
  return <canvas ref={ref} width={WIDTH} height={HEIGHT} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />;
}

export const orbitCanvas: CardDef<Params> = {
  id: "rs-orbit-canvas",
  name: "Orbiting dots",
  description: "A ring of dots on the canvas orbits the center; positions and sizes are determined by the seed",
  source: "user",
  useWhen: "Framework example: use when drawing on a canvas a set of points whose positions are computed directly from time.",
  tags: ["canvas", "dots", "example"],
  frameMode: "direct",
  defaults: { count: 160, seed: 11, color: "#9bf6ff", speed: 1 },
  controls: [
    { key: "count", label: "Number of dots", type: "number", min: 1, max: 400, step: 1 },
    { key: "seed", label: "Random seed", type: "number", min: 0, max: 9999, step: 1 },
    { key: "color", label: "Color", type: "color" },
    { key: "speed", label: "Rotation speed", type: "number", min: 0, max: 4, step: 0.1 },
  ],
  Component: OrbitCanvas,
  lifecycle: { settleMs: 1200, after: "evolve", exit: ["fade"] },
};
