/**
 * The small square avatar in front of a reply.
 *
 * No image assets: a role card is just a .md under src/ai/roles/, users can add one at any time,
 * and after adding one they should not also have to supply an image. So the color is hashed from
 * the role id and the glyph is the first character of the name: a new role gets a stable avatar,
 * distinct from the others, as soon as it is dropped in.
 *
 * A square rather than a circle: consistent with the right-angle style of the whole UI, and
 * distinct from the bubble of user messages.
 */
import { ALL_ROLES } from "../../ai/roles";
import "./RoleAvatar.css";
import { tr } from "../../i18n/index.ts";

/**
 * Derives a hue from a string. There is only one requirement: the same id must get the same color
 * every time. In other words Math.random cannot be used, or the avatar would change color on every
 * re-render.
 */
function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export function RoleAvatar(props: { roleId?: string; size?: number }) {
  const { roleId, size = 20 } = props;
  const role = roleId ? ALL_ROLES.find((r) => r.id === roleId) : undefined;

  // With no role (plain chat, or the role card was deleted) fall back to a neutral assistant avatar.
  // Don't skip showing it just because the role is not found: then bubbles with and without a role
  // would differ in height.
  const name = role?.name ?? "AI";
  const seed = role?.id ?? "assistant";
  const hue = hueOf(seed);

  return (
    <span
      className="pc-role-avatar"
      style={{
        width: size,
        height: size,
        // With no role, use a zero-saturation gray, so real roles stand out more among a pile of replies
        background: role ? `hsl(${hue} 45% 32%)` : "var(--fill-subtle)",
        borderColor: role ? `hsl(${hue} 45% 46%)` : "var(--hairline-strong)",
        color: role ? `hsl(${hue} 60% 88%)` : "var(--ink-muted)",
        fontSize: Math.round(size * 0.55),
      }}
      title={role ? tr("{0} ({1})", role.name, role.capability === "planning" ? tr("Planning") : tr("Execution")) : tr("AI assistant")}
      aria-label={name}
    >
      {name.slice(0, 1)}
    </span>
  );
}

/** Avatar + name, taking a whole row. Placed at the top of each reply in division-of-labor mode. */
export function RoleHeader(props: { roleId?: string }) {
  const role = props.roleId ? ALL_ROLES.find((r) => r.id === props.roleId) : undefined;
  return (
    <div className="pc-role-header">
      <RoleAvatar roleId={props.roleId} />
      <span className="pc-role-name">{role?.name ?? tr("AI assistant")}</span>
    </div>
  );
}

/** Name only. The chat row already has an avatar on the left; another avatar inside the bubble would be redundant */
export function RoleName(props: { roleId?: string }) {
  const role = props.roleId ? ALL_ROLES.find((r) => r.id === props.roleId) : undefined;
  return <span className="pc-role-name">{role?.name ?? tr("AI assistant")}</span>;
}
