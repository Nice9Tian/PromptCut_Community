/**
 * 手机版界面的入口(语义 `product/platforms.md`「身份」:身份为手机的在线浏览器用手机版界面)。
 * `Shell` 判定一次界面后按需载入本模块:桌面界面不下载手机版的代码和样式。
 */
import "./mobile.css";
import { MobileEditor } from "./MobileEditor";
import { MobileStart } from "./MobileStart";
import { ConfirmHost, ToastHost } from "./ui";

export default function MobileApp({ inEditor, onEnterEditor }: { inEditor: boolean; onEnterEditor: () => void }) {
  return (
    <div className="pcm" data-pc="mobile-ui">
      <ToastHost>
        <ConfirmHost>
          {inEditor ? <MobileEditor /> : <MobileStart onEnterEditor={onEnterEditor} />}
        </ConfirmHost>
      </ToastHost>
    </div>
  );
}
