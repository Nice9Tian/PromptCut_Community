export const layoutTools = [
  {
    name: "set_position",
    description: "给卡片定位:把它的锚点放到画面上某个坐标,可选尺寸、缩放、旋转。**这是把任何卡片摆到任何位置的正道**——不再受卡片自带 position 档位(center/bottom/…)限制,不用为了位置换卡。坐标系:舞台像素,原点左上角,1920×1080 时中心是 960,540。anchor 决定 x,y 指的是框内哪个点([0,0] 左上、[0.5,0.5] 中心、[1,1] 右下),缩放和旋转也绕它;例如把卡片中心放到左半屏正中:{ x:480, y:540, anchor:[0.5,0.5] }。只传的字段会改,其余保留;传 clear:true 恢复铺满全屏。w/h 是卡片的**画布**尺寸(大多数卡按 1920×1080 设计,缩小画布不等于缩小内容,整体缩小用 scale)。space 对卡片级 world/local 等价(父坐标系就是舞台),将来部件级才有区别。**三维**:rotateX / rotateY / translateZ 把卡片摆进空间,但要先调 set_camera3d 打开透视,否则看到的是仿射拉伸不是透视。返回 layout 的 local / world 和 look;实体框 contentBox 要另调 get_layout。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        space: { type: "string", enum: ["world", "local"], description: "默认 local;卡片级两者等价" },
        x: { type: "number", description: "锚点的横坐标(像素)" },
        y: { type: "number", description: "锚点的纵坐标(像素)" },
        w: { type: "number", description: "画布宽(像素),省略=舞台宽" },
        h: { type: "number", description: "画布高(像素),省略=舞台高" },
        anchor: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "[ax, ay],0~1;默认 [0,0]" },
        scale: { type: "number", description: "绕锚点缩放,默认 1" },
        rotate: { type: "number", description: "绕锚点旋转,度,顺时针,默认 0。这是**平面内**的旋转" },
        rotateX: { type: "number", description: "三维:绕水平轴翻转,度。正值=**顶边往里倒、底边朝观众抬起来**(像把牌子朝后仰)。**要先用 set_camera3d 打开三维**,否则只会看到仿射拉伸而不是透视。**只对卡片生效**,素材段(视频/图片)会被拒" },
        rotateY: { type: "number", description: "三维:绕垂直轴翻转,度。正值=**右边往里转、左边朝观众转过来**。同样要先 set_camera3d,同样只对卡片生效" },
        translateZ: { type: "number", description: "三维:沿深度平移,舞台像素,正值朝观众(变大)、负值往里(变小)。同样要先 set_camera3d,同样只对卡片生效。注意推得太靠前会越过相机:translateZ 接近\"相机距离\"(set_camera3d 会告诉你这个数)时卡片会涨到占满整幅甚至更大" },
        clear: { type: "boolean", description: "true = 删掉框,恢复铺满全屏" },
        clamp: { type: "boolean", description: "true = 算完后把可见框夹回舞台内,不让卡片出画" }
      },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "set_rect",
    description: "把卡片放进画面上的一个矩形(两个对角点,顺序随意)。**要把卡放到「空的那一边」首选它**。mode 默认 fit:画布不动,整体缩放到刚好装进矩形、保持比例,按 align 对齐在矩形里(默认居中)——大多数卡按 1920×1080 设计,这样缩放后的内容一定在矩形内。mode:canvas 则画布就是这个矩形(内容按卡片自己的规则重新布局,可能溢出,只在你确实要改画布尺寸时用)。返回 layout 的 local / world(看 world.visualBox 核对)和 look,不含 contentBox。和 set_position / align / nudge 改的是同一个框,只是说法不同。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        x1: { type: "number" }, y1: { type: "number" },
        x2: { type: "number" }, y2: { type: "number" },
        mode: { type: "string", enum: ["fit", "canvas"], description: "默认 fit" },
        align: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2, description: "在矩形里靠哪:[0,0] 左上、[0.5,0.5] 中心(默认)、[1,1] 右下" }
      },
      required: ["clipId", "x1", "y1", "x2", "y2"]
    },
    side: "agent"
  },
  {
    name: "align",
    description: "把卡片贴到画面的边或中心,带边距:h 是 left/center/right,v 是 top/center/bottom,只传一个另一个方向不动。锚点会跟着对齐方式走,缩放过的卡片贴的是可见框的边。**铺满全屏又没缩小的卡片对齐看不出效果**(画布和舞台一样大),返回里会带 note 提醒——先 set_rect 或 nudge scaleBy 缩小再对齐。返回 layout 的 local / world 和 look,不含 contentBox。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        h: { type: "string", enum: ["left", "center", "right"] },
        v: { type: "string", enum: ["top", "center", "bottom"] },
        margin: { type: "number", description: "离边的像素,默认 0" }
      },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "nudge",
    description: "在现有位置上微调:dx/dy 加像素(右、下为正),scaleBy 乘倍数(0.8 = 缩小两成),rotateBy 加角度(顺时针)。看完 look 觉得「再往左一点、再小一点」就用它,不用重算绝对坐标。返回 layout 的 local / world 和 look,不含 contentBox。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        dx: { type: "number" }, dy: { type: "number" },
        scaleBy: { type: "number" }, rotateBy: { type: "number" },
        clamp: { type: "boolean", description: "true = 算完后把可见框夹回舞台内,不让卡片出画;微调时建议带上" }
      },
      required: ["clipId"]
    },
    side: "agent"
  },
  {
    name: "get_layout",
    description: "读卡片的布局:local(存下来的框,没设过为 null 即铺满全屏)、world(算出来的画面绝对位置:锚点坐标、尺寸、box 是画布矩形、visualBox 是缩放旋转之后画布真正占的矩形)和 **contentBox(量出来的实体内容框:文字、图片、有底色的盒子的并集,透明容器不算)**。判断「这张卡会不会盖住人」看 contentBox —— 默认卡的画布铺满全屏,看 box/visualBox 永远是「会盖住」;判断「会不会出画」看 visualBox。contentBox 由预渲染按整场景在指定时刻实测,卡片此刻不在画面上时为 null 并附 contentNote(先 seek 进它的时段)。不传 clipId 返回全部卡片和素材段的加舞台尺寸。set_position / set_rect / align / nudge 四个工具改的都是同一个框,任何一个改完都能在这里读到一致的结果。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" }
      }
    },
    side: "agent"
  },
  {
    name: "set_camera3d",
    description:
      "打开 / 关掉三维透视,并调它的强度。**这是三维的唯一开关**,整个项目一档,不是逐卡的。" +
      "关着的时候 set_position 的 rotateX / rotateY / translateZ 只会得到仿射拉伸 —— 卡片被斜切,但没有近大远小,看着像贴纸不像立在空间里。" +
      "打开之后舞台变成一个透视空间:屏幕平面是 z=0,translateZ 正值朝观众来(变大)、负值往里去(变小)。" +
      "\n\n" +
      "强度用 fovDeg(视场角)调,**没有\"相机距离\"这个参数** —— 距离是从 fov 和画布高度推出来的(d = H / (2·tan(fov/2)))。" +
      "这么设计是因为竖屏项目画布高 1920、横屏 1080,同一个距离在两种画幅下透视强度完全不同,而 fov 直接就是\"透视有多强\",换画幅不用重调。" +
      "档位:**30° 克制**(接近正交,适合规整的信息版面)、**40° 默认**、**50~60° 明显**(卡片一转就有纵深)、**80° 以上是鱼眼**,边角会夸张变形。" +
      "\n\n" +
      "改完一定要 see_frames 看真实画面:透视强度只能看出来,算不出来。",
    inputSchema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "true = 打开三维(不同时传 fovDeg 时:这个项目之前调过就回到那个值,没调过用默认 40°);false = 关掉,回到纯二维。卡片上已有的 rotateX/rotateY/translateZ 不会被清掉,只是不再有透视",
        },
        fovDeg: {
          type: "number",
          description: "视场角(度),5~120,越大透视越夸张。传了它就等于同时把三维打开,不用再传 enabled",
        },
      },
    },
    side: "agent",
  }
];
