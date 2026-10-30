export const effectsTools = [
  {
    name: "list_filters",
    description: "列出滤镜库(素材库「转场/滤镜」页里的那些),以及能用的滤镜种类、取值范围和表达式写法。每条给 filterId、name、description、params(挂到片段上可逐段调的参数)、ops、summary、animated(有没有随时间变的步骤)、usedBy(挂在哪几段上)。挂滤镜前先看有没有现成能复用的。",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "create_filter",
    description: "新建一个滤镜,放进素材库「转场/滤镜」页 —— 用户能看到、能复用,你也能挂到任意视频 / 图片片段上。整帧调色(曲线、通道混色、色偏、按亮度换色调)用这里的 curves / matrix —— 它们由 GPU 合成器做、不占预览的每拍预算;**不要为整帧调色去用 create_pixel_map**(那是逐像素选区用的)。ops 是依次作用的几步。查表 / 矩阵两种(不随时间变,不写 value):curves 曲线 { kind:'curves', rgb?:[…], r?:[…], g?:[…], b?:[…] },每张表 2~33 个 0~1 的数、均匀铺在输入 0~1 上、点之间线性插值,rgb 是三通道共用的简写,例:提亮中间调 { kind:'curves', rgb:[0,0.3,0.62,0.86,1] }、压暗蓝通道高光 { kind:'curves', b:[0,0.5,0.88] };matrix 颜色矩阵 { kind:'matrix', values:[rr,rg,rb, gr,gg,gb, br,bg,bb], offset?:[r,g,b] },values 每个 -4~4(原样是 [1,0,0,0,1,0,0,0,1]),offset 每通道 -1~1、在混色截断之后再加,例:青橙 { kind:'matrix', values:[1.1,0.05,0, 0,1,0.05, 0.02,0,0.9], offset:[-0.02,0,0.03] }。带数值的 kind 八种:brightness 亮度(1 原样,0~3,乘法)、contrast 对比度(1 原样,0~3)、saturate 饱和度(1 原样,0~2)、hue 色相旋转(度,-180~180)、grayscale 黑白(0~1)、sepia 复古褐(0~1)、invert 反色(0~1)、blur 模糊(片段框内的像素,0~40;框缩小了模糊跟着缩)。value 写数字,或写**随时间变化的表达式字符串**:t = 片段内秒数(从片段开头算,所以同一个滤镜挂到哪段都一样用)、d = 片段时长、p = t/d(0~1 进度),还能引用 params 里声明的参数;函数有 sin cos abs min max pow clamp lerp step smoothstep 等,常量 PI。例:{ name:'呼吸感', params:{ amount:{ default:0.15, min:0, max:0.5, label:'幅度' } }, ops:[{ kind:'brightness', value:'1 + amount*sin(t*2*PI)' }] };整段褪成黑白:{ kind:'grayscale', value:'p' }。传 clipId 就顺手挂到那一段上。预览、导出、see_frames 算的是同一份数值。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "素材库里显示的名字,30 字以内" },
        description: { type: "string", description: "一句话说它是什么效果、适合什么画面" },
        params: {
          type: "object",
          description: "可选:可逐段调的参数,键是参数名(小写字母开头),值是 { default, min?, max?, label? }。表达式里直接用参数名",
          additionalProperties: {
            type: "object",
            properties: {
              default: { type: "number" },
              min: { type: "number" },
              max: { type: "number" },
              label: { type: "string" }
            },
            required: ["default"]
          }
        },
        ops: {
          type: "array",
          description: "依次作用的步骤,1~12 步",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["brightness", "contrast", "saturate", "hue", "grayscale", "sepia", "invert", "blur", "curves", "matrix"] },
              value: { anyOf: [{ type: "number" }, { type: "string" }], description: "八种带数值的 kind 用:数字,或含 t / d / p / 参数名的表达式字符串。curves / matrix 不写" },
              rgb: { type: "array", items: { type: "number" }, description: "curves:三通道共用的取样表,2~33 个 0~1 的数" },
              r: { type: "array", items: { type: "number" }, description: "curves:红通道的表(优先于 rgb)" },
              g: { type: "array", items: { type: "number" }, description: "curves:绿通道的表" },
              b: { type: "array", items: { type: "number" }, description: "curves:蓝通道的表" },
              values: { type: "array", items: { type: "number" }, description: "matrix:行优先 3×3,9 个 -4~4 的数" },
              offset: { type: "array", items: { type: "number" }, description: "matrix:可选,[r,g,b] 每个 -1~1" }
            },
            required: ["kind"]
          }
        },
        clipId: { type: "string", description: "可选:建完直接挂到这一段(视频 / 图片)" },
        clipParams: { type: "object", description: "可选:挂上时这一段的参数值,覆盖 params 的 default" }
      },
      required: ["name", "ops"]
    },
    side: "agent"
  },
  {
    name: "update_filter",
    description: "改滤镜库里的一个滤镜。挂着它的片段**全部**跟着变(片段引用的是它,不是复制了一份)。给了 ops / params 就整项替换。只想改某一段的效果,用 apply_filter 给那一段传 params 覆盖,或另建一个滤镜。",
    inputSchema: {
      type: "object",
      properties: {
        filterId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        params: { type: "object", description: "同 create_filter" },
        ops: { type: "array", items: { type: "object" }, description: "同 create_filter" }
      },
      required: ["filterId"]
    },
    side: "agent"
  },
  {
    name: "remove_filter",
    description: "从滤镜库删掉一个滤镜。还挂在片段上时会被拒;确实要删就传 force:true 并在 reason 里写明理由(用户会看到),所有剪辑里挂着它的片段会一起摘掉。",
    inputSchema: {
      type: "object",
      properties: {
        filterId: { type: "string" },
        force: { type: "boolean" },
        reason: { type: "string" }
      },
      required: ["filterId"]
    },
    side: "agent"
  },
  {
    name: "apply_filter",
    description: "把滤镜库里的一个滤镜挂到视频 / 图片片段上(每段只挂一个,再挂就是替换);params 给这一段单独的参数值。filterId 传空字符串就是摘掉。卡片片段不收(卡片用自己的样式参数)。挂完用 see_frames 看一眼真实效果。",
    inputSchema: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        filterId: { type: "string", description: "空字符串 = 摘掉这一段的滤镜" },
        params: { type: "object", description: "可选:这一段的参数值,只能是这个滤镜 params 里声明过的" }
      },
      required: ["clipId", "filterId"]
    },
    side: "agent"
  },
  {
    name: "list_pixel_maps",
    description: "列出项目里的通用像素映射。像素映射只做**要逐像素判断的选区**（抠色、按位置/时间的选区、换成另一段素材）；整帧调色请用 create_filter 的 curves / matrix。where 允许 r/g/b/a/luma/x/y/t，to 可以是 {kind:'media',mediaId,stage:'origin'|'after_filters'}、{kind:'color',value:'#ff0000'}、{kind:'transparent'} 或 {kind:'expr',r,g,b,a}。先调用 list_media 找素材 id，再用 list_media_effects 看已有滤镜和映射。",
    inputSchema: { type: "object", properties: {} },
    side: "agent"
  },
  {
    name: "create_pixel_map",
    description: "**整帧调色请用 create_filter 的 curves / matrix，这个工具只给要逐像素选区的活。**（曲线、通道混色、色偏、按亮度换色调都是整帧调色——它们由 GPU 合成器做、不占预览的每拍预算；像素映射走自己的 WebGL 片元着色器，逐像素算、每张图各编一个 program。传进来的定义如果算整帧调色会被当场拒绝，错误里会附一份可以直接照抄的 create_filter ops。）适合这个工具的：抠色（where 引用 r/g/b/luma 做选区）、按位置或时间的选区（引用 x/y/t）、to 是 transparent 或另一段素材、通道互相依赖的非线性表达式。创建后走 WebGL 片元着色器，可选 clipId 直接挂到视频/图片片段。where 是 0~1 软选区，例如 'smoothstep(0.35,0.8,g-r)*(1-smoothstep(0.15,0.45,b))'；to 可写 {kind:'media',mediaId:'B',stage:'origin'|'after_filters'}、{kind:'color',value:'#ff0000'}、{kind:'transparent'} 或每通道表达式 {kind:'expr',r:'r^1.6',g:'g^1.6',b:'b^1.6',a:'a'}。mode=continuous 会混合，discrete 会选离散颜色（顶层 mode 说了算，colorSequence 里的 mode 只是回显）。颜色序列可传 colorSequence:{from:['#000000','#ffffff'],to:['#001133','#ffcc88']}，取色是对 from 做 RGB 最近邻、两端长度不等时按首尾对齐插值。表达式只翻译不执行 JavaScript，函数集和普通滤镜相同；底数可能为负的乘方要把底数包进 abs() 或把指数写成整数常量，否则翻译不成着色器。创建后用 see_frames 复核。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        source: { type: "object", description: "映射输入媒体，可含 mediaId、stage(origin/after_filters)、filterId" },
        where: { type: "string", description: "0~1 选区表达式，变量 r/g/b/a/luma/x/y/t" },
        to: { description: "目标可写字符串 '#ff0000'、'transparent'、素材 id，也可写 media/color/transparent/expr 对象；使用 colorSequence 时可省略" },
        mode: { type: "string", enum: ["continuous", "discrete"] },
        colorSequence: { type: "object", description: "可选 from/to 颜色序列及 mode" },
        clipId: { type: "string" }
      },
      required: ["name", "where"]
    },
    side: "agent"
  },
  {
    name: "update_pixel_map",
    description: "更新项目里的像素映射。给出的字段会替换定义；挂载它的片段都会跟着变。改完用 see_frames 看真实效果。和 create_pixel_map 一样只收要逐像素选区的活：改完之后如果变成了整帧调色（where 成了常数、to 只是颜色到颜色的函数），会被拒绝并附上等价的 create_filter ops。",
  inputSchema: { type: "object", properties: { pixelMapId: { type: "string" }, name: { type: "string" }, description: { type: "string" }, source: { type: "object" }, where: { type: "string" }, to: { description: "字符串颜色/transparent/素材 id，或目标对象" }, mode: { type: "string", enum: ["continuous", "discrete"] }, colorSequence: { type: "object" } }, required: ["pixelMapId"] },
    side: "agent"
  },
  {
    name: "remove_pixel_map",
    description: "删除一个像素映射。仍挂在片段上时需要 force:true，并在 reason 写明用户可见的理由；只想摘掉一段请用 apply_pixel_map 的空 pixelMapId。",
    inputSchema: { type: "object", properties: { pixelMapId: { type: "string" }, force: { type: "boolean" }, reason: { type: "string" } }, required: ["pixelMapId"] },
    side: "agent"
  },
  {
    name: "apply_pixel_map",
    description: "把像素映射挂到视频/图片片段上；每段只挂一条，再挂就是替换。pixelMapId 传空字符串表示摘掉。to 为媒体时 stage 决定取素材原始像素还是该素材滤镜后的输出。挂完用 see_frames 复核。",
    inputSchema: { type: "object", properties: { clipId: { type: "string" }, pixelMapId: { type: "string", description: "空字符串=摘掉" } }, required: ["clipId", "pixelMapId"] },
    side: "agent"
  }
];
