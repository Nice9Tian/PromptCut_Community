import { typingMountClockMs } from "../kernel/typingEvents";

/**
 * 挂载钟(`CardProps.mountClockMs`)的记账,从 `Stage` 里拆出来好单测。
 *
 * 平铺时间轴的导出页(`ExportView` 里不经 `FrameScene` 的那个 `Stage`)提前 `CARD_MOUNT_LEAD` 挂载卡片。
 * 旧的「挂载即播」打字卡从挂载那一帧的页面时钟起计时,所以在这条路径上它比片段起点早走这一段(30 fps 下一帧),
 * 导出像素基线(默认演示项目)就是那样渲出来的。按 `t` 取字的新卡要逐帧一致,就得知道自己早挂了多久。
 *
 * `mountedAt`:这一次挂载(`片段 id:代数`,和包裹层的 key 同一个)第一次渲染时的舞台时刻(秒)。
 * 返回值:在片段起点之前挂上的卡 → 自挂载起经过的毫秒(与旧实现同一个算式);
 * 在起点或之后才挂上的(从片段中间开始导、重挂载)→ `undefined`,卡照常按 `t`,不让「从中间接着打」退回「从头打」。
 */
export function mountClockMsAt(mountedAt: Map<string, number>, key: string, clipStart: number, now: number): number | undefined {
  let at = mountedAt.get(key);
  if (at === undefined) mountedAt.set(key, at = now);
  return at < clipStart ? typingMountClockMs(now, at) : undefined;
}

/** 这一次渲染没挂的卡清掉:它再进来是一次新的挂载,钟从那时重新起算(和旧卡重挂载即重播一致)。 */
export function forgetUnmounted(mountedAt: Map<string, number>, live: ReadonlySet<string>): void {
  for (const key of [...mountedAt.keys()]) if (!live.has(key)) mountedAt.delete(key);
}
