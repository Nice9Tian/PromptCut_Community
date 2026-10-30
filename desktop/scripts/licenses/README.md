# 许可证全文（随拓展库包分发）

`make-extension.mjs` 打包时把这三份全文追加到包内的 `THIRD-PARTY-LICENSES.txt` 末尾，
`apply-extension.ps1` 再把它拷到 `%APPDATA%\com.promptcut.desktop\models\` 旁边。
MIT / Apache-2.0 / BSD-3-Clause 都要求「随分发附带许可证全文」，只写一个许可证名字不算数。

文件名就是 SPDX 标识符，`MODEL_META` 里每个模型的 `license` 字段必须能在这里找到同名文件
（`KNOWN_LICENSES` 由目录内容生成，写错一个字母就打不出包）。

三份全文的来源（2026-09-07 用 curl 取，都和 SPDX 官方文本逐字比对过）：

| 文件 | 取自 | 与 SPDX 的关系 |
| --- | --- | --- |
| `MIT.txt` | https://raw.githubusercontent.com/opencv/opencv_zoo/main/models/face_detection_yunet/LICENSE | 正文与 https://spdx.org/licenses/MIT.txt 逐字相同（diff 过），只把具体版权行换回 `<year> <copyright holders>` 占位符 —— 这份全文同时适用于 TransNet V2 和 YuNet 两个权重 |
| `BSD-3-Clause.txt` | https://raw.githubusercontent.com/ShiqiYu/libfacedetection.train/master/LICENSE | 正文与 https://spdx.org/licenses/BSD-3-Clause.txt 的模板逐字相同（diff 过），同样把版权行换回占位符 |
| `Apache-2.0.txt` | https://www.apache.org/licenses/LICENSE-2.0.txt | 与 https://spdx.org/licenses/Apache-2.0.txt 内容相同；用官方版是因为它保留了原始折行和结尾的 APPENDIX（SPDX 那份把段落压成了单行） |

各模型自己的版权行不在这些文件里，写在 `THIRD-PARTY-LICENSES.txt` 每段全文的抬头，
由 `buildLicenseText` 从 `MODEL_META` 生成 —— 版权行是逐模型的，全文是共用的。
