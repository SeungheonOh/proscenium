// Warlock's glyphs: 24px line art drawn at 1.8px, tinted where they are used.
import actions from "./assets/glyphs/actions.svg";
import arrowLeft from "./assets/glyphs/arrow-left.svg";
import arrowRight from "./assets/glyphs/arrow-right.svg";
import bell from "./assets/glyphs/bell.svg";
import check from "./assets/glyphs/check.svg";
import close from "./assets/glyphs/close.svg";
import contrast from "./assets/glyphs/contrast.svg";
import desktop from "./assets/glyphs/desktop.svg";
import document from "./assets/glyphs/document.svg";
import download from "./assets/glyphs/download.svg";
import fieldSearchDawn from "./assets/glyphs/field-search-dawn.svg";
import fieldSearchNight from "./assets/glyphs/field-search-night.svg";
import folder from "./assets/glyphs/folder.svg";
import fullscreen from "./assets/glyphs/fullscreen.svg";
import gear from "./assets/glyphs/gear.svg";
import go from "./assets/glyphs/go.svg";
import grid from "./assets/glyphs/grid.svg";
import help from "./assets/glyphs/help.svg";
import home from "./assets/glyphs/home.svg";
import image from "./assets/glyphs/image.svg";
import keyboard from "./assets/glyphs/keyboard.svg";
import largeFile from "./assets/glyphs/large-file.svg";
import layers from "./assets/glyphs/layers.svg";
import lock from "./assets/glyphs/lock.svg";
import logout from "./assets/glyphs/logout.svg";
import maximize from "./assets/glyphs/maximize.svg";
import minimize from "./assets/glyphs/minimize.svg";
import moon from "./assets/glyphs/moon.svg";
import motion from "./assets/glyphs/motion.svg";
import move from "./assets/glyphs/move.svg";
import mute from "./assets/glyphs/mute.svg";
import network from "./assets/glyphs/network.svg";
import newWindow from "./assets/glyphs/new-window.svg";
import onTop from "./assets/glyphs/on-top.svg";
import open from "./assets/glyphs/open.svg";
import pin from "./assets/glyphs/pin.svg";
import power from "./assets/glyphs/power.svg";
import recent from "./assets/glyphs/recent.svg";
import refresh from "./assets/glyphs/refresh.svg";
import restart from "./assets/glyphs/restart.svg";
import save from "./assets/glyphs/save.svg";
import screenshot from "./assets/glyphs/screenshot.svg";
import search from "./assets/glyphs/search.svg";
import snap from "./assets/glyphs/snap.svg";
import sparkle from "./assets/glyphs/sparkle.svg";
import speaker from "./assets/glyphs/speaker.svg";
import sun from "./assets/glyphs/sun.svg";
import suspend from "./assets/glyphs/suspend.svg";
import switcher from "./assets/glyphs/switcher.svg";
import taskView from "./assets/glyphs/task-view.svg";
import textSize from "./assets/glyphs/text-size.svg";
import unavailable from "./assets/glyphs/unavailable.svg";
import unpin from "./assets/glyphs/unpin.svg";
import video from "./assets/glyphs/video.svg";
import warlock from "./assets/glyphs/warlock.svg";
import window from "./assets/glyphs/window.svg";

export const glyphs = {
  actions,
  arrowLeft,
  arrowRight,
  bell,
  check,
  close,
  contrast,
  desktop,
  document,
  download,
  fieldSearchDawn,
  fieldSearchNight,
  folder,
  fullscreen,
  gear,
  go,
  grid,
  help,
  home,
  image,
  keyboard,
  largeFile,
  layers,
  lock,
  logout,
  maximize,
  minimize,
  moon,
  motion,
  move,
  mute,
  network,
  newWindow,
  onTop,
  open,
  pin,
  power,
  recent,
  refresh,
  restart,
  save,
  screenshot,
  search,
  snap,
  sparkle,
  speaker,
  sun,
  suspend,
  switcher,
  taskView,
  textSize,
  unavailable,
  unpin,
  video,
  warlock,
  window,
} as const;

export type GlyphName = keyof typeof glyphs;
