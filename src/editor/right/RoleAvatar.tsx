/**
 * 回复前面那个小方块头像。
 *
 * 不用图片资源：角色卡就是 src/ai/roles/ 下的 .md，用户随时能加一个，
 * 加完不该还要配一张图。所以颜色由角色 id 哈希出来，字取名字的第一个字 ——
 * 新角色一放进去就自动有一个稳定、和别人不重样的头像。
 *
 * 方块而不是圆：和整个界面的直角风格一致，也和用户消息那种气泡区分开。
 */
import { ALL_ROLES } from "../../ai/roles";
import "./RoleAvatar.css";

/**
 * 从字符串定出一个色相。要求只有一条：同一个 id 每次都得到同一个颜色，
 * 换句话说不能用 Math.random，否则每次重渲染头像都在变色。
 */
function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export function RoleAvatar(props: { roleId?: string; size?: number }) {
  const { roleId, size = 20 } = props;
  const role = roleId ? ALL_ROLES.find((r) => r.id === roleId) : undefined;

  // 没有角色（普通对话、或者角色卡被删了）就退回一个中性的助手头像，
  // 不要因为找不到角色就不显示——那样带角色和不带角色的气泡会长得不一样高。
  const name = role?.name ?? "AI";
  const seed = role?.id ?? "assistant";
  const hue = hueOf(seed);

  return (
    <span
      className="pc-role-avatar"
      style={{
        width: size,
        height: size,
        // 无角色时用零饱和度的灰，让真正的角色在一堆回复里更跳出来
        background: role ? `hsl(${hue} 45% 32%)` : "var(--fill-subtle)",
        borderColor: role ? `hsl(${hue} 45% 46%)` : "var(--hairline-strong)",
        color: role ? `hsl(${hue} 60% 88%)` : "var(--ink-muted)",
        fontSize: Math.round(size * 0.55),
      }}
      title={role ? `${role.name}（${role.capability === "planning" ? "规划" : "执行"}）` : "AI 助手"}
      aria-label={name}
    >
      {name.slice(0, 1)}
    </span>
  );
}

/** 头像 + 名字，占一整行。分工模式下每条回复顶上放这个。 */
export function RoleHeader(props: { roleId?: string }) {
  const role = props.roleId ? ALL_ROLES.find((r) => r.id === props.roleId) : undefined;
  return (
    <div className="pc-role-header">
      <RoleAvatar roleId={props.roleId} />
      <span className="pc-role-name">{role?.name ?? "AI 助手"}</span>
    </div>
  );
}

/** 只有名字。聊天行左边已经有头像了,气泡里再放一个头像就重复了 */
export function RoleName(props: { roleId?: string }) {
  const role = props.roleId ? ALL_ROLES.find((r) => r.id === props.roleId) : undefined;
  return <span className="pc-role-name">{role?.name ?? "AI 助手"}</span>;
}
