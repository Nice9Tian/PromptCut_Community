// Facade for backward compatibility
// Only re-export the names originally public in project.ts before splitting (EditorState /
// planPlacement / getState / subscribe / useStore, plus actions assembled below; StoreHold is for
// section tabs hidden by the dock; onLocalCommit is for "User is editing" to listen to this page's
// own modifications, see src/editor/userEditing.ts). state, set, setProject, history, future,
// listeners, emit, etc. in core.ts are package-internal primitives, used only by src/store/actions,
// not re-exported from here.
export type { EditorState } from "./core";
export { getState, subscribe, useStore, StoreHold, planPlacement, onLocalCommit, setProjectLoader, withMerge } from "./core";

import { coreActions } from "./actions/coreActions";
import { projectMeta } from "./actions/projectMeta";
import { playback } from "./actions/playback";
import { tracks } from "./actions/tracks";
import { clips } from "./actions/clips";
import { media } from "./actions/media";
import { effects } from "./actions/effects";
import { audio } from "./actions/audio";
import { sound } from "./actions/sound";
import { captions } from "./actions/captions";
import { cuts } from "./actions/cuts";
import { properties } from "./actions/properties";

export const actions = {
  ...coreActions,
  ...projectMeta,
  ...playback,
  ...tracks,
  ...clips,
  ...media,
  ...effects,
  ...audio,
  ...sound,
  ...captions,
  ...cuts,
  ...properties,
};
