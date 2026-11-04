/**
 * Entry of the mobile app UI (semantics `product/platforms.md` "Identity": an online browser whose identity is mobile uses the mobile app UI).
 * `Shell` decides the UI once and then loads this module on demand: the desktop UI does not download the mobile app's code and styles.
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
